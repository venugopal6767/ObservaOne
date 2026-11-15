// observaone-traces-webhook — SCAFFOLD (not compiled/tested here).
//
// A mutating admission webhook that injects OpenTelemetry env vars into pods carrying
// the annotation observaone.io/traces=true. This is a minimal starting point; for
// production prefer the upstream OpenTelemetry Operator (see ../instrumentation.yaml).
//
// Build + deploy (on a machine with Go, Docker, and a cluster):
//   go mod tidy && CGO_ENABLED=0 go build -o webhook .
//   docker build -t REGISTRY/observaone-traces-webhook:dev . && docker push ...
//   kubectl apply -f crd.yaml -f webhook.yaml
//
// TODO before production: resolve injection target from the ObservaInstrumentation CR
// (language, endpoint, sampler), add initContainer-based SDK injection for Java/Node/etc.,
// metrics/healthz, and cert reload. This file injects a fixed OTLP env set as a template.
package main

import (
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"

	admissionv1 "k8s.io/api/admission/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type patchOp struct {
	Op    string      `json:"op"`
	Path  string      `json:"path"`
	Value interface{} `json:"value,omitempty"`
}

// otelEnv is the env injected into the first container. In production, derive endpoint/
// sampler/service from the matching ObservaInstrumentation CR instead of hardcoding.
func otelEnv(pod *corev1.Pod) []corev1.EnvVar {
	return []corev1.EnvVar{
		{Name: "OTEL_EXPORTER_OTLP_PROTOCOL", Value: "http/protobuf"},
		{Name: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", Value: "http://$(NODE_IP):4318/v1/traces"},
		{Name: "OTEL_SERVICE_NAME", Value: pod.Labels["app"]},
		{Name: "NODE_IP", ValueFrom: &corev1.EnvVarSource{FieldRef: &corev1.ObjectFieldSelector{FieldPath: "status.hostIP"}}},
	}
}

func mutate(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	var review admissionv1.AdmissionReview
	if err := json.Unmarshal(body, &review); err != nil || review.Request == nil {
		http.Error(w, "bad admission review", http.StatusBadRequest)
		return
	}
	var pod corev1.Pod
	_ = json.Unmarshal(review.Request.Object.Raw, &pod)

	var patches []patchOp
	for i := range pod.Spec.Containers {
		patches = append(patches, patchOp{
			Op:    "add",
			Path:  fmt.Sprintf("/spec/containers/%d/env/-", i),
			Value: otelEnv(&pod),
		})
	}
	patchBytes, _ := json.Marshal(patches)
	pt := admissionv1.PatchTypeJSONPatch
	resp := admissionv1.AdmissionReview{
		TypeMeta: metav1.TypeMeta{APIVersion: "admission.k8s.io/v1", Kind: "AdmissionReview"},
		Response: &admissionv1.AdmissionResponse{
			UID: review.Request.UID, Allowed: true, Patch: patchBytes, PatchType: &pt,
		},
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(resp)
}

func main() {
	cert := flag.String("tls-cert", "/tls/tls.crt", "TLS cert")
	key := flag.String("tls-key", "/tls/tls.key", "TLS key")
	flag.Parse()
	mux := http.NewServeMux()
	mux.HandleFunc("/mutate", mutate)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
	srv := &http.Server{Addr: ":8443", Handler: mux, TLSConfig: &tls.Config{MinVersion: tls.VersionTLS12}}
	fmt.Println("observaone-traces-webhook listening on :8443")
	panic(srv.ListenAndServeTLS(*cert, *key))
}
