package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Identity is what the server gave this agent at enrollment. It survives restarts and re-installs
// (the installer never deletes the state directory unless you uninstall).
type Identity struct {
	AgentID    string    `json:"agentId"`
	Host       string    `json:"host"`
	Server     string    `json:"server"`
	EnrolledAt time.Time `json:"enrolledAt"`
}

var credRE = regexp.MustCompile(`^oac_[0-9a-f]{20}_[A-Za-z0-9_-]{43}$`)

// ValidCredential: well-formed and for this agent (oac_<the agent id's 20 hex digits>_<secret>).
func ValidCredential(c, agentID string) bool {
	return credRE.MatchString(c) && len(agentID) == 24 && c[4:24] == agentID[4:]
}

func identityPath(dir string) string   { return filepath.Join(dir, "identity.json") }
func credentialPath(dir string) string { return filepath.Join(dir, "credential") }

// LoadIdentity returns (nil, nil) when the agent has never enrolled.
func LoadIdentity(dir string) (*Identity, string, error) {
	b, err := os.ReadFile(identityPath(dir))
	if errors.Is(err, os.ErrNotExist) {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	var id Identity
	if err := json.Unmarshal(b, &id); err != nil || id.AgentID == "" {
		return nil, "", fmt.Errorf("%s is damaged; re-enroll (run the installer again with a token)", identityPath(dir))
	}
	c, err := os.ReadFile(credentialPath(dir))
	if err != nil {
		return nil, "", fmt.Errorf("credential missing (%v); re-enroll", err)
	}
	cred := strings.TrimSpace(string(c))
	if !credRE.MatchString(cred) {
		return nil, "", fmt.Errorf("%s is damaged; re-enroll", credentialPath(dir))
	}
	return &id, cred, nil
}

// SaveIdentity writes the credential (0600) and identity atomically: a crash or a full disk
// leaves either the old files or the new ones, never a half-written file.
func SaveIdentity(dir string, id *Identity, credential string) error {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return err
	}
	if err := WriteFileAtomic(credentialPath(dir), []byte(credential+"\n"), 0o600); err != nil {
		return fmt.Errorf("saving credential: %w", err)
	}
	b, _ := json.MarshalIndent(id, "", "  ")
	if err := WriteFileAtomic(identityPath(dir), append(b, '\n'), 0o640); err != nil {
		return fmt.Errorf("saving identity: %w", err)
	}
	return nil
}

func WriteFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
