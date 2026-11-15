// release-sign: signs agent/files/SHA256SUMS with the release key (Ed25519), so installers and the updater can
// check that the binaries were published by this ObservaOne server's build, not swapped on disk later.
//
//	release-sign -key agent/keys/release-signing.key -pub agent/files/release.pub -sign agent/files/SHA256SUMS
//
// The key is created on first use (0600). Keep agent/keys out of backups you share and out of git (.gitignore).
// Writes <file>.sig (base64 Ed25519 signature) and the public key (PEM) for installers to download.
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

func main() {
	keyPath := flag.String("key", "", "private key file (created if missing)")
	pubPath := flag.String("pub", "", "where to write the public key (PEM)")
	file := flag.String("sign", "", "file to sign")
	flag.Parse()
	if *keyPath == "" || *pubPath == "" || *file == "" {
		flag.Usage()
		os.Exit(2)
	}
	priv, err := loadOrCreate(*keyPath)
	if err != nil {
		fail(err)
	}
	data, err := os.ReadFile(*file)
	if err != nil {
		fail(err)
	}
	sig := ed25519.Sign(priv, data)
	if err := os.WriteFile(*file+".sig", []byte(base64.StdEncoding.EncodeToString(sig)+"\n"), 0o644); err != nil {
		fail(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(priv.Public())
	if err := os.WriteFile(*pubPath, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0o644); err != nil {
		fail(err)
	}
	fmt.Printf("signed %s (key %s)\n", *file, *keyPath)
}

func loadOrCreate(path string) (ed25519.PrivateKey, error) {
	if b, err := os.ReadFile(path); err == nil {
		blk, _ := pem.Decode(b)
		if blk == nil {
			return nil, fmt.Errorf("%s: not PEM", path)
		}
		k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
		if err != nil {
			return nil, err
		}
		if p, ok := k.(ed25519.PrivateKey); ok {
			return p, nil
		}
		return nil, fmt.Errorf("%s: not an Ed25519 key", path)
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	der, _ := x509.MarshalPKCS8PrivateKey(priv)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600); err != nil {
		return nil, err
	}
	fmt.Println("created release signing key", path)
	return priv, nil
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "release-sign:", err)
	os.Exit(1)
}
