// observaone-agent: the ObservaOne monitoring agent.
//
//	observaone-agent run            [--config FILE]   run (what systemd starts)
//	observaone-agent enroll         [--config FILE] [--token-file FILE]   (token from the file, or typed on stdin)
//	observaone-agent status         [--config FILE]   what the running agent last did
//	observaone-agent check-config   [--config FILE]   validate agent.yaml + conf.d/*.yaml
//	observaone-agent config show    [--config FILE]   settings in effect and where each one comes from
//	observaone-agent config migrate [--config FILE]   turn an old agent.conf into agent.yaml
//	observaone-agent reload         [--config FILE]   apply config changes without a restart (SIGHUP)
//	observaone-agent diagnostics    [--config FILE]   print the diagnostics bundle (what "Request diagnostics" uploads)
//	observaone-agent verify-release --key PUB --sums SHA256SUMS --sig SHA256SUMS.sig   (used by the installer and updater)
//	observaone-agent version
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"observaone/agent/internal/agent"
	"observaone/agent/internal/collector/linux"
	"observaone/agent/internal/core"
)

// version is set at build time: -ldflags "-X main.version=1.1.0"
var version = "1.3.0"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	if cmd == "config" && len(args) > 0 && (args[0] == "show" || args[0] == "migrate") {
		cmd, args = "config-"+args[0], args[1:]
	}
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	cfgPath := fs.String("config", core.DefaultConfigPath(), "configuration file (agent.yaml; an old agent.conf is still read)")
	tokenFile := fs.String("token-file", "", "enroll: read the enrollment token from this file (deleted after a successful enrollment)")
	force := fs.Bool("force", false, "enroll: enroll again even if this agent already has an identity")
	relKey := fs.String("key", "", "verify-release: the pinned release public key")
	relSums := fs.String("sums", "", "verify-release: SHA256SUMS")
	relSig := fs.String("sig", "", "verify-release: SHA256SUMS.sig")
	_ = fs.Parse(args)
	ring := core.NewLogRing(300)
	log := slog.New(slog.NewJSONHandler(io.MultiWriter(os.Stderr, ring), &slog.HandlerOptions{Level: slog.LevelInfo}))

	var err error
	switch cmd {
	case "run":
		err = run(*cfgPath, log, ring)
		if errors.Is(err, agent.ErrRestartRequested) {
			os.Exit(agent.RestartExitCode) // systemd (Restart=on-failure) starts the agent again
		}
	case "diagnostics":
		err = diagnostics(*cfgPath, log)
	case "verify-release":
		if err = core.VerifyRelease(*relKey, *relSums, *relSig); err == nil {
			fmt.Println("signature OK")
		}
	case "enroll":
		err = enroll(*cfgPath, *tokenFile, *force, log)
	case "status":
		err = status(*cfgPath)
	case "check-config":
		var c *core.Config
		c, err = core.LoadConfig(*cfgPath)
		if err == nil {
			for _, f := range c.LegacyFiles {
				fmt.Printf("note: %s uses the old key = value format; run 'observaone-agent config migrate'\n", f)
			}
			fmt.Println("configuration OK")
		}
	case "config-show":
		err = showConfig(*cfgPath)
	case "config-migrate":
		err = migrateConfig(*cfgPath)
	case "reload":
		err = reload(*cfgPath)
	case "version", "--version", "-v":
		fmt.Printf("observaone-agent %s\n", version)
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "ERROR:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: observaone-agent run|enroll|status|check-config|config show|config migrate|reload|diagnostics|verify-release|version [--config FILE]")
}

func diagnostics(cfgPath string, log *slog.Logger) error {
	a := &agent.Agent{Version: version, ConfigPath: cfgPath, Collectors: linux.All(), Log: log}
	if err := a.Load(); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	b, _ := json.MarshalIndent(a.Diagnostics(ctx), "", "  ")
	fmt.Println(string(b))
	return nil
}

func run(cfgPath string, log *slog.Logger, ring *core.LogRing) error {
	a := &agent.Agent{Version: version, ConfigPath: cfgPath, Collectors: linux.All(), Log: log, LogRing: ring}
	if err := a.Load(); err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	reload := make(chan struct{}, 1)
	go func() {
		for range hup {
			select {
			case reload <- struct{}{}:
			default:
			}
		}
	}()
	if err := os.WriteFile(a.Config().StateDir+"/agent.pid", []byte(fmt.Sprint(os.Getpid())), 0o640); err != nil {
		log.Warn("cannot write pid file", "error", err.Error())
	}
	return a.Run(ctx, reload)
}

func enroll(cfgPath, tokenFile string, force bool, log *slog.Logger) error {
	cfg, err := core.LoadConfig(cfgPath)
	if err != nil {
		return err
	}
	if id, _, err := core.LoadIdentity(cfg.StateDir); err == nil && id != nil && !force {
		fmt.Printf("Already enrolled as %s (%s) with %s. Keeping this identity.\n", id.AgentID, id.Host, id.Server)
		return nil
	}
	var token string
	if tokenFile != "" {
		b, err := os.ReadFile(tokenFile)
		if err != nil {
			return fmt.Errorf("token file: %w", err)
		}
		token = string(b)
	} else {
		// from stdin, so it never appears in the process list or shell history
		fmt.Fprint(os.Stderr, "Enrollment token: ")
		token, _ = bufio.NewReader(os.Stdin).ReadString('\n')
		fmt.Fprintln(os.Stderr)
	}
	osName, kernel := linux.OSInfo(cfg.ProcPath, cfg.RootPath)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	id, err := agent.Enroll(ctx, cfg, version, token, osName, kernel, log)
	if err != nil {
		var ae *core.APIError
		if errors.As(err, &ae) {
			switch ae.Code {
			case "token_revoked", "token_expired", "token_used_up", "invalid_token":
				return fmt.Errorf("%s (create a new token on the Agents page)", ae.Msg)
			}
		}
		return err
	}
	if tokenFile != "" {
		if err := os.Remove(tokenFile); err != nil { // the token has done its job; do not leave it on disk
			fmt.Fprintf(os.Stderr, "WARNING: could not delete %s (%v); delete it yourself\n", tokenFile, err)
		}
	}
	fmt.Printf("Enrolled: agent %s, shown as %q in ObservaOne.\n", id.AgentID, id.Host)
	return nil
}

func status(cfgPath string) error {
	cfg, err := core.LoadConfig(cfgPath)
	if err != nil {
		return err
	}
	id, _, err := core.LoadIdentity(cfg.StateDir)
	if err != nil {
		return err
	}
	if id == nil {
		fmt.Println("Not enrolled.")
		return nil
	}
	fmt.Printf("Agent      %s (%s)\nServer     %s\n", id.AgentID, id.Host, cfg.Server)
	st, err := agent.ReadStatus(cfg.StateDir)
	if err != nil {
		fmt.Println("Running    unknown (no status file yet: is the service running?)")
		return nil
	}
	ago := func(t *time.Time) string {
		if t == nil {
			return "never"
		}
		return time.Since(*t).Round(time.Second).String() + " ago"
	}
	fmt.Printf("Version    %s (pid %d, status written %s)\n", st.Version, st.PID, ago(&st.WrittenAt))
	fmt.Printf("Server says %s\nHeartbeat  %s\nUpload     %s  (buffered %d, dropped %d, failures %d)\n",
		nz(st.ServerStatus, "-"), ago(st.LastHeartbeatOK), ago(st.LastUploadOK), st.BufferedPayloads, st.DroppedPayloads, st.UploadFailures)
	if st.DiskBuffered > 0 {
		fmt.Printf("Disk buffer %d collections waiting\n", st.DiskBuffered)
	}
	if st.LastError != "" {
		fmt.Printf("Last error %s\n", st.LastError)
	}
	for _, k := range agent.SortedKeys(st.Collectors) {
		c := st.Collectors[k]
		fmt.Printf("  %-11s %-11s %s\n", k, c.Status, c.Error)
	}
	return nil
}

func showConfig(cfgPath string) error {
	cfg, err := core.LoadConfigWithRemote(cfgPath, agent.LoadRemote(cfgPath)) // what the running agent uses
	if err != nil {
		return err
	}
	for _, r := range cfg.Effective() {
		fmt.Printf("%-20s %-45s %s\n", r[0], nz(r[1], "(empty)"), r[2])
	}
	return nil
}

// migrateConfig writes agent.yaml next to an old agent.conf (same settings) and renames the old file
// to agent.conf.migrated. conf.d/*.conf files are converted the same way. Safe to run twice.
func migrateConfig(cfgPath string) error {
	if !core.IsLegacyPath(cfgPath) {
		if _, err := os.Stat(cfgPath); err == nil {
			fmt.Printf("%s is already YAML; nothing to migrate.\n", cfgPath)
			return nil
		}
		cfgPath = strings.TrimSuffix(strings.TrimSuffix(cfgPath, ".yaml"), ".yml") + ".conf"
	}
	if _, err := core.LoadConfig(cfgPath); err != nil {
		return fmt.Errorf("the old configuration is not valid, fix it first: %w", err)
	}
	dir := filepath.Dir(cfgPath)
	files := []string{cfgPath}
	extra, _ := filepath.Glob(filepath.Join(dir, "conf.d", "*.conf"))
	files = append(files, extra...)
	for _, f := range files {
		c := core.Defaults()
		if err := c.ReadOne(f); err != nil {
			return err
		}
		out := strings.TrimSuffix(f, ".conf") + ".yaml"
		if f == cfgPath {
			out = filepath.Join(dir, "agent.yaml")
		}
		if _, err := os.Stat(out); err == nil {
			return fmt.Errorf("%s already exists; not overwriting it", out)
		}
		st, _ := os.Stat(f)
		if err := core.WriteFileAtomic(out, []byte(c.HostYAML()), st.Mode().Perm()); err != nil {
			return err
		}
		if sys, ok := st.Sys().(*syscall.Stat_t); ok {
			_ = os.Chown(out, int(sys.Uid), int(sys.Gid))
		}
		if err := os.Rename(f, f+".migrated"); err != nil {
			return err
		}
		fmt.Printf("%s -> %s\n", f, out)
	}
	if _, err := core.LoadConfig(filepath.Join(dir, "agent.yaml")); err != nil {
		return fmt.Errorf("migrated configuration does not validate (the old files are kept as *.migrated): %w", err)
	}
	fmt.Println("Done. Point the service at agent.yaml (the installer does this) and restart the agent.")
	return nil
}

func reload(cfgPath string) error {
	cfg, err := core.LoadConfig(cfgPath)
	if err != nil {
		return fmt.Errorf("not reloading, the new configuration is invalid: %w", err)
	}
	b, err := os.ReadFile(cfg.StateDir + "/agent.pid")
	if err != nil {
		return fmt.Errorf("agent not running? %w", err)
	}
	var pid int
	if _, err := fmt.Sscan(strings.TrimSpace(string(b)), &pid); err != nil || pid <= 1 {
		return fmt.Errorf("bad pid file")
	}
	if err := syscall.Kill(pid, syscall.SIGHUP); err != nil {
		return err
	}
	fmt.Println("reload requested")
	return nil
}

func nz(s, d string) string {
	if s == "" {
		return d
	}
	return s
}
