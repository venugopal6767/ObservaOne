// observaone-agent: the ObservaOne monitoring agent.
//
//	observaone-agent run            [--config FILE]   run (what systemd starts)
//	observaone-agent enroll         [--config FILE] [--token-file FILE]   (token from the file, or typed on stdin)
//	observaone-agent status         [--config FILE]   what the running agent last did
//	observaone-agent check-config   [--config FILE]   validate agent.conf + conf.d/*.conf
//	observaone-agent config show    [--config FILE]   settings in effect and where each one comes from
//	observaone-agent reload         [--config FILE]   apply config changes without a restart (SIGHUP)
//	observaone-agent version
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"observaone/agent/internal/agent"
	"observaone/agent/internal/collector/linux"
	"observaone/agent/internal/core"
)

// version is set at build time: -ldflags "-X main.version=1.1.0"
var version = "1.1.0"

const defaultConfig = "/etc/observaone-agent/agent.conf"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	if cmd == "config" && len(args) > 0 && args[0] == "show" {
		cmd, args = "config-show", args[1:]
	}
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	cfgPath := fs.String("config", defaultConfig, "configuration file")
	tokenFile := fs.String("token-file", "", "enroll: read the enrollment token from this file (deleted after a successful enrollment)")
	force := fs.Bool("force", false, "enroll: enroll again even if this agent already has an identity")
	_ = fs.Parse(args)
	log := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	var err error
	switch cmd {
	case "run":
		err = run(*cfgPath, log)
	case "enroll":
		err = enroll(*cfgPath, *tokenFile, *force, log)
	case "status":
		err = status(*cfgPath)
	case "check-config":
		_, err = core.LoadConfig(*cfgPath)
		if err == nil {
			fmt.Println("configuration OK")
		}
	case "config-show":
		err = showConfig(*cfgPath)
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
	fmt.Fprintln(os.Stderr, "usage: observaone-agent run|enroll|status|check-config|config show|reload|version [--config FILE]")
}

func run(cfgPath string, log *slog.Logger) error {
	a := &agent.Agent{Version: version, ConfigPath: cfgPath, Collectors: linux.All(), Log: log}
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
	cfg, err := core.LoadConfig(cfgPath)
	if err != nil {
		return err
	}
	for _, r := range cfg.Effective() {
		fmt.Printf("%-20s %-45s %s\n", r[0], nz(r[1], "(empty)"), r[2])
	}
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
