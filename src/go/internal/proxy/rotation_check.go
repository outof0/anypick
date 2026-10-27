package proxy

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/outof0/anypick/go/internal/anyerr"
)

// rotationProbeTimeout bounds each probe. The endpoint is loopback and the
// check never reaches upstream, so anything slower is a proxy that is not up.
const rotationProbeTimeout = 5 * time.Second

// VerifyTokenRotation proves a rotation took effect on the running proxy at
// endpoint: current must be accepted and previous refused. Returning success
// from a rotation whose old key still works would tell the user a leaked key
// is dead when it is not.
//
// Neither secret appears in the returned error (ADR 0006 §6): a failure names
// which key misbehaved and the status it got, nothing more.
func VerifyTokenRotation(ctx context.Context, endpoint, current, previous string) error {
	if strings.TrimSpace(endpoint) == "" || current == "" {
		return rotationUnverified("the proxy reported no endpoint to check")
	}
	client := &http.Client{
		Timeout: rotationProbeTimeout,
		// Loopback only: an HTTP(S)_PROXY in the environment must not carry
		// the bearer to another host.
		Transport: &http.Transport{Proxy: nil},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	defer client.CloseIdleConnections()

	status, err := probeAuthCheck(ctx, client, endpoint, current)
	if err != nil {
		return rotationUnverified("the proxy did not answer: " + err.Error())
	}
	if status != http.StatusNoContent {
		return rotationUnverified(fmt.Sprintf("the new key was refused (HTTP %d)", status))
	}
	if previous == "" || previous == current {
		return nil
	}
	status, err = probeAuthCheck(ctx, client, endpoint, previous)
	if err != nil {
		return rotationUnverified("the proxy did not answer: " + err.Error())
	}
	if status != http.StatusUnauthorized {
		return rotationUnverified(fmt.Sprintf("the previous key is still accepted (HTTP %d)", status))
	}
	return nil
}

func probeAuthCheck(ctx context.Context, client *http.Client, endpoint, token string) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		strings.TrimRight(endpoint, "/")+AuthCheckPath, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	// A transport error quotes the loopback URL, never request headers, so it
	// is safe to surface as is.
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	_ = resp.Body.Close()
	return resp.StatusCode, nil
}

func rotationUnverified(detail string) error {
	return anyerr.Newf("The key was rotated, but "+detail+".", "PROXY_ROTATION_UNVERIFIED",
		anyerr.WithSuggestions("Restart the proxy and run the rotation again."))
}
