package agent

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"

	"observaone/agent/internal/core"
)

func testCert(t *testing.T, key *ecdsa.PrivateKey, ips []string, nb, na time.Time) *x509.Certificate {
	t.Helper()
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "agt"}, NotBefore: nb, NotAfter: na}
	for _, ip := range ips {
		tpl.IPAddresses = append(tpl.IPAddresses, net.ParseIP(ip))
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return c
}

func TestCertNeedsRenewal(t *testing.T) {
	now := time.Now()
	k1, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	k2, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	fresh := testCert(t, k1, []string{"10.0.0.5"}, now.Add(-time.Hour), now.Add(90*24*time.Hour))
	old := testCert(t, k1, []string{"10.0.0.5"}, now.Add(-70*24*time.Hour), now.Add(20*24*time.Hour))
	cases := []struct {
		leaf *x509.Certificate
		key  *ecdsa.PrivateKey
		ips  []string
		want string
	}{
		{nil, k1, nil, "no certificate"},
		{fresh, k2, []string{"10.0.0.5"}, "another key"},
		{old, k1, []string{"10.0.0.5"}, "due for renewal"},
		{fresh, k1, []string{"10.0.0.5", "10.0.0.6"}, "10.0.0.6 is new"},
		{fresh, k1, []string{"10.0.0.5"}, ""},
	}
	for i, c := range cases {
		got := certNeedsRenewal(c.leaf, c.key, c.ips, nil, now)
		if (c.want == "") != (got == "") || !strings.Contains(got, c.want) {
			t.Errorf("case %d: want %q, got %q", i, c.want, got)
		}
	}
}

func TestPullAddressesAdvertise(t *testing.T) {
	c := core.Defaults()
	c.PullAdvertise = "10.1.2.3:9200"
	ips, dns := pullAddresses(c)
	if len(ips) != 1 || ips[0] != "10.1.2.3" || dns != nil || pullPort(c) != 9200 {
		t.Fatalf("ip advertise: %v %v %d", ips, dns, pullPort(c))
	}
	c.PullAdvertise = "Web01.Example.com"
	ips, dns = pullAddresses(c)
	if ips != nil || len(dns) != 1 || dns[0] != "web01.example.com" || pullPort(c) != 9110 {
		t.Fatalf("dns advertise: %v %v %d", ips, dns, pullPort(c))
	}
}
