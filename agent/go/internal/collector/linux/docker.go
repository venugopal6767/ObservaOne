package linux

// Docker: the containers on this host, in cAdvisor's metric names (container_cpu_usage_seconds_total,
// container_memory_working_set_bytes, ...) so container dashboards work unchanged.
//
// Off by default (docker.enabled). Names and states come from the Docker API over the local socket (GET only);
// CPU and memory are read from the containers' cgroups (v2, or v1), falling back to the stats API.
// Reading the Docker socket needs the agent user in the "docker" group, which on most systems is as powerful
// as root: that is why it is opt-in, and the agent only ever sends GET requests to it.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"observaone/agent/internal/collector"
	"observaone/agent/internal/core"
)

type Docker struct{}

func (Docker) Name() string { return "docker" }

type dockerContainer struct {
	ID     string   `json:"Id"`
	Names  []string `json:"Names"`
	Image  string   `json:"Image"`
	State  string   `json:"State"`
	Status string   `json:"Status"`
}

func dockerClient(socket string) *http.Client {
	return &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, "unix", socket)
			},
			MaxIdleConns: 1,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func dockerGet(cl *http.Client, path string, out any) error {
	resp, err := cl.Get("http://docker" + path)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("docker API %s: HTTP %d", path, resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(out)
}

func (Docker) Collect(env *collector.Env, b *core.Batch) error {
	if env.Cfg == nil || !env.Cfg.DockerEnabled {
		return collector.ErrNotConfigured
	}
	socket := env.Cfg.DockerSocket
	if _, err := os.Stat(socket); err != nil {
		return fmt.Errorf("docker socket %s: %w (is Docker installed?)", socket, err)
	}
	cl := dockerClient(socket)
	var list []dockerContainer
	if err := dockerGet(cl, "/containers/json?all=true", &list); err != nil {
		if strings.Contains(err.Error(), "permission denied") {
			return fmt.Errorf("%w: add the agent user to the docker group (sudo usermod -aG docker observaone-agent) and restart the agent", os.ErrPermission)
		}
		return err
	}
	if len(list) > 200 {
		list = list[:200]
	}
	states := map[string]int{}
	for _, c := range list {
		name := strings.TrimPrefix(firstOr(c.Names, c.ID[:12]), "/")
		image := c.Image
		if len(image) > 120 {
			image = image[:120]
		}
		states[c.State]++
		b.Add("observaone_docker_container_info", core.Gauge, "One series per container: its name, image and state.", 1, "name", name, "image", image, "state", c.State)
		if c.State != "running" {
			continue
		}
		lbl := []string{"name", name, "image", image, "container", name, "id", "/docker/" + c.ID}
		cpu, mem, ws, limit, err := cgroupStats(env, c.ID)
		if err != nil {
			cpu, mem, ws, limit, err = statsAPI(cl, c.ID)
		}
		if err != nil {
			env.Note("docker " + name + ": " + err.Error())
			continue
		}
		b.Add("container_cpu_usage_seconds_total", core.Counter, "CPU seconds used by the container.", cpu, lbl...)
		b.Add("container_memory_usage_bytes", core.Gauge, "Memory used by the container, page cache included.", mem, lbl...)
		b.Add("container_memory_working_set_bytes", core.Gauge, "Memory used by the container, without inactive page cache (what limits act on).", ws, lbl...)
		if limit > 0 {
			b.Add("container_spec_memory_limit_bytes", core.Gauge, "Memory limit of the container.", limit, lbl...)
		}
	}
	for _, st := range []string{"running", "exited", "paused", "restarting", "created", "dead"} {
		b.Add("observaone_docker_containers", core.Gauge, "Containers by state.", float64(states[st]), "state", st)
	}
	return nil
}

func firstOr(s []string, d string) string {
	if len(s) > 0 {
		return s[0]
	}
	return d
}

// cgroupStats reads CPU and memory of a container from its cgroup (v2 systemd or cgroupfs layout, or v1).
func cgroupStats(env *collector.Env, id string) (cpu, mem, ws, limit float64, err error) {
	base := filepath.Join(env.Sys, "fs/cgroup")
	for _, dir := range []string{filepath.Join(base, "system.slice", "docker-"+id+".scope"), filepath.Join(base, "docker", id)} {
		if st, e := readKV(filepath.Join(dir, "cpu.stat")); e == nil { // v2
			cpu = st["usage_usec"] / 1e6
			mem, _ = readNum(filepath.Join(dir, "memory.current"))
			ms, _ := readKV(filepath.Join(dir, "memory.stat"))
			ws = mem - ms["inactive_file"]
			if ws < 0 {
				ws = 0
			}
			limit, _ = readNum(filepath.Join(dir, "memory.max")) // "max" = no limit -> error -> 0
			return cpu, mem, ws, limit, nil
		}
	}
	for _, sub := range []string{"docker/" + id, "system.slice/docker-" + id + ".scope"} { // v1
		ns, e := readNum(filepath.Join(base, "cpuacct", sub, "cpuacct.usage"))
		if e != nil {
			continue
		}
		mem, _ = readNum(filepath.Join(base, "memory", sub, "memory.usage_in_bytes"))
		ms, _ := readKV(filepath.Join(base, "memory", sub, "memory.stat"))
		ws = mem - ms["total_inactive_file"]
		if ws < 0 {
			ws = 0
		}
		limit, _ = readNum(filepath.Join(base, "memory", sub, "memory.limit_in_bytes"))
		if limit > 1<<60 {
			limit = 0
		}
		return ns / 1e9, mem, ws, limit, nil
	}
	return 0, 0, 0, 0, errors.New("cgroup not found")
}

func statsAPI(cl *http.Client, id string) (cpu, mem, ws, limit float64, err error) {
	var st struct {
		CPU struct {
			Usage struct {
				Total float64 `json:"total_usage"`
			} `json:"cpu_usage"`
		} `json:"cpu_stats"`
		Mem struct {
			Usage float64            `json:"usage"`
			Limit float64            `json:"limit"`
			Stats map[string]float64 `json:"stats"`
		} `json:"memory_stats"`
	}
	if err = dockerGet(cl, "/containers/"+id+"/stats?stream=false&one-shot=true", &st); err != nil {
		return
	}
	inactive := st.Mem.Stats["inactive_file"]
	if inactive == 0 {
		inactive = st.Mem.Stats["total_inactive_file"]
	}
	ws = st.Mem.Usage - inactive
	if ws < 0 {
		ws = 0
	}
	return st.CPU.Usage.Total / 1e9, st.Mem.Usage, ws, st.Mem.Limit, nil
}

func readNum(path string) (float64, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	return strconv.ParseFloat(strings.TrimSpace(string(b)), 64)
}

func readKV(path string) (map[string]float64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	m := map[string]float64{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		x := strings.Fields(sc.Text())
		if len(x) == 2 {
			if v, err := strconv.ParseFloat(x[1], 64); err == nil {
				m[x[0]] = v
			}
		}
	}
	return m, sc.Err()
}
