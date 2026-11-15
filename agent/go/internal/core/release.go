package core

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"os"
	"strings"
)

// VerifyRelease checks SHA256SUMS against its Ed25519 signature with the release public key the installer
// pinned on first install (/etc/observaone-agent/release.pub). Used by the updater before installing anything.
func VerifyRelease(pubPath, sumsPath, sigPath string) error {
	pb, err := os.ReadFile(pubPath)
	if err != nil {
		return err
	}
	blk, _ := pem.Decode(pb)
	if blk == nil {
		return fmt.Errorf("%s: not a PEM public key", pubPath)
	}
	k, err := x509.ParsePKIXPublicKey(blk.Bytes)
	if err != nil {
		return err
	}
	pub, ok := k.(ed25519.PublicKey)
	if !ok {
		return fmt.Errorf("%s: not an Ed25519 key", pubPath)
	}
	data, err := os.ReadFile(sumsPath)
	if err != nil {
		return err
	}
	sb, err := os.ReadFile(sigPath)
	if err != nil {
		return err
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sb)))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return fmt.Errorf("%s: not a signature", sigPath)
	}
	if !ed25519.Verify(pub, data, sig) {
		return fmt.Errorf("SIGNATURE MISMATCH: %s was not signed by the pinned release key", sumsPath)
	}
	return nil
}
