// Package buildinfo holds values injected at link time with
//
//	go build -ldflags "-X github.com/outof0/anypick/go/internal/buildinfo.Version=X.Y.Z"
//
// The release pipeline (native cutover Milestone 8) must set Version from the
// single release tag so every channel reports one version. The default keeps
// source builds honest: `go build ./cmd/anypick` reports "(devel)" rather than
// impersonating a release.
package buildinfo

// Version is the released package version ("1.2.3") or "(devel)".
var Version = "(devel)"

// ProtocolVersion is the app-owned desktop stdio protocol. Version 2 adds the
// mandatory handshake; its negotiated command/snapshot DTO version remains 1
// during the ownership cutover.
const ProtocolVersion = 3

// IsRelease reports whether the binary was linked with a real version.
func IsRelease() bool { return Version != "" && Version != "(devel)" }
