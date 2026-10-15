// Package desktop implements the desktop-app core protocol: the core speaks
// line-framed base64 JSON over stdio —
//
//	core → app : snapshot\t<b64> | result\t<b64> | logs\t<b64> | doctor\t<b64> | backup-preview\t<b64>
//	app → core : open|refresh|restart|stop|quit | navigate\t<s>
//	             | invoke\t<b64> | mutate\t<b64> | model-roles\t<b64>
//	             | logs\t<b64> | doctor\t<b64> | backup-inspect\t<b64> | cancel\t<b64>
package desktop

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/outof0/anypick/go/internal/doctor"
)

// ProtocolVersion is the command and snapshot DTO wire version, retained
// while the negotiated service contract moves on (see ServiceProtocolVersion,
// which is buildinfo.ProtocolVersion).
const ProtocolVersion = 1

// MaxCommandBytes bounds one inbound command line.
const MaxCommandBytes = 16 * 1024

// Command is the decoded form of one app→core line.
type Command struct {
	Kind    string          // open|refresh|restart|stop|quit|navigate|invoke|model-roles|logs|doctor|backup-inspect|cancel|mutate
	Screen  string          // navigate target
	Payload json.RawMessage // decoded JSON body for prefixed kinds
}

// RequestID reports the requestId carried by the command's payload, when it has
// one. A command that dies before publishing a result answers with a
// protocol-error naming this id, so the host can settle the row it belongs to
// instead of waiting out its confirm timeout.
func (c *Command) RequestID() string {
	if len(c.Payload) == 0 {
		return ""
	}
	var probe struct {
		RequestID string `json:"requestId"`
	}
	if json.Unmarshal(c.Payload, &probe) != nil {
		return ""
	}
	return probe.RequestID
}

type invokePayload struct {
	Version   int    `json:"version"`
	RequestID string `json:"requestId"`
	Revision  int    `json:"revision"`
	ActionID  string `json:"actionId"`
	// AllowForeignConfig is the user's answer to CLIENT_CONFIG_FOREIGN: the
	// app re-invokes the same action after showing what AnyPick would replace.
	// Absent means no consent, so an unconfirmed take-over is impossible.
	AllowForeignConfig bool `json:"allowForeignConfig,omitempty"`
}

type modelRolesPayload struct {
	Version       int               `json:"version"`
	RequestID     string            `json:"requestId"`
	Revision      int               `json:"revision"`
	ClientID      string            `json:"clientId"`
	RoleActionIDs map[string]string `json:"roleActionIds"`
	// Scope selects where the choice lands: "connection" pins this
	// connection (default, historical behavior), "provider" stores it as
	// the provider default and re-resolves this connection against it.
	Scope string `json:"scope,omitempty"`
}

type logsPayload struct {
	Version    int    `json:"version"`
	RequestID  string `json:"requestId"`
	ProviderID string `json:"providerId"`
	Name       string `json:"name"`
	Lines      int    `json:"lines"`
}

type doctorPayload struct {
	Version   int    `json:"version"`
	RequestID string `json:"requestId"`
}

type backupInspectPayload struct {
	Version   int    `json:"version"`
	RequestID string `json:"requestId"`
	Path      string `json:"path"`
}

type cancelPayload struct {
	Version   int    `json:"version"`
	RequestID string `json:"requestId"`
}

// Mutate is the mutation command: unknown fields are dropped, so
// new operations surface as unsupported instead of crashing the supervisor.
type Mutate struct {
	Version      int    `json:"version"`
	RequestID    string `json:"requestId"`
	Operation    string `json:"operation"`
	ProviderID   string `json:"providerId"`
	SourceID     string `json:"sourceId"`
	MethodID     string `json:"methodId"`
	Label        string `json:"label"`
	Endpoint     string `json:"endpoint"`
	APIKey       string `json:"apiKey"`
	Region       string `json:"region"`
	GatewayID    string `json:"gatewayId,omitempty"`
	DefaultModel string `json:"defaultModel"`
	Overwrite    bool   `json:"overwrite"`
	Enabled      bool   `json:"enabled"`
	Language     string `json:"language,omitempty"`
	Name         string `json:"name"`
	Path         string `json:"path"`
	// account-save-input carries the credential product the user picked in
	// the native Add Account sheet. The secret itself travels in APIKey —
	// the same field gateway-create already uses for profile secrets — so
	// no second secret-shaped field is introduced.
	Kind            string   `json:"kind"`
	Profile         string   `json:"profile"`
	TransportPolicy string   `json:"transportPolicy,omitempty"`
	SourceIDs       []string `json:"sourceIds,omitempty"`
	// Backup-package operations (account refs / import flow).
	Accounts           []BackupAccountRef `json:"accounts,omitempty"`
	InspectionID       string             `json:"inspectionId,omitempty"`
	EntryIDs           []string           `json:"entryIds,omitempty"`
	OverwriteConfirmed bool               `json:"overwriteConfirmed,omitempty"`
}

// BackupAccountRef names one account in a backup-package operation.
type BackupAccountRef struct {
	Provider string `json:"provider"`
	Name     string `json:"name"`
}

var simpleKinds = map[string]bool{
	"open": true, "refresh": true, "restart": true, "stop": true, "quit": true,
}

var navigateScreens = map[string]bool{
	"accounts": true, "gateways": true, "proxy": true, "proxy-hub": true,
	"add-account": true, "add-gateway": true,
}

// DecodeLine decodes one app→core line. Malformed input returns an error the
// caller ignores — a bad line must never disrupt supervision.
func DecodeLine(line string) (*Command, error) {
	if len(line) > MaxCommandBytes {
		return nil, fmt.Errorf("command too large")
	}
	if simpleKinds[line] {
		return &Command{Kind: line}, nil
	}
	const (
		invokeP   = "invoke\x09"
		rolesP    = "model-roles\x09"
		logsP     = "logs\x09"
		doctorP   = "doctor\x09"
		inspectP  = "backup-inspect\x09"
		cancelP   = "cancel\x09"
		mutateP   = "mutate\x09"
		navigateP = "navigate\x09"
	)
	switch {
	case strings.HasPrefix(line, navigateP):
		screen := strings.TrimPrefix(line, navigateP)
		if !navigateScreens[screen] {
			return nil, fmt.Errorf("unknown screen %q", screen)
		}
		return &Command{Kind: "navigate", Screen: screen}, nil
	case strings.HasPrefix(line, invokeP):
		var p invokePayload
		raw, err := decodeStrictPayload(strings.TrimPrefix(line, invokeP), "invoke", &p)
		if err != nil {
			return nil, err
		}
		return &Command{Kind: "invoke", Payload: raw}, nil
	case strings.HasPrefix(line, rolesP):
		var p modelRolesPayload
		raw, err := decodeStrictPayload(strings.TrimPrefix(line, rolesP), "model-roles", &p)
		if err != nil {
			return nil, err
		}
		return &Command{Kind: "model-roles", Payload: raw}, nil
	case strings.HasPrefix(line, logsP):
		var p logsPayload
		raw, err := decodeStrictPayload(strings.TrimPrefix(line, logsP), "logs", &p)
		if err != nil {
			return nil, err
		}
		return &Command{Kind: "logs", Payload: raw}, nil
	case strings.HasPrefix(line, doctorP):
		var p doctorPayload
		raw, err := decodeStrictPayload(strings.TrimPrefix(line, doctorP), "doctor", &p)
		if err != nil {
			return nil, err
		}
		return &Command{Kind: "doctor", Payload: raw}, nil
	case strings.HasPrefix(line, inspectP):
		var p backupInspectPayload
		raw, err := decodeStrictPayload(strings.TrimPrefix(line, inspectP), "backup-inspect", &p)
		if err != nil {
			return nil, err
		}
		return &Command{Kind: "backup-inspect", Payload: raw}, nil
	case strings.HasPrefix(line, cancelP):
		var p cancelPayload
		raw, err := decodeStrictPayload(strings.TrimPrefix(line, cancelP), "cancel", &p)
		if err != nil {
			return nil, err
		}
		return &Command{Kind: "cancel", Payload: raw}, nil
	case strings.HasPrefix(line, mutateP):
		var p Mutate
		raw, err := decodeStrictPayload(strings.TrimPrefix(line, mutateP), "mutate", &p)
		if err != nil {
			return nil, err
		}
		return &Command{Kind: "mutate", Payload: raw}, nil
	default:
		return nil, fmt.Errorf("unrecognized line")
	}
}

func decodeB64Body(encoded string, into interface{}) error {
	if encoded == "" || len(encoded) > MaxCommandBytes {
		return fmt.Errorf("bad payload length")
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return fmt.Errorf("bad base64: %w", err)
	}
	return json.Unmarshal(raw, into)
}

func frame(prefix string, v interface{}) string {
	raw, err := json.Marshal(v)
	if err != nil {
		// A frame with an empty body is unparseable to the host, which then
		// cannot tell a broken engine from a broken request — and a strict
		// client treats it as a protocol failure. Answer with the rejection
		// shape every host version understands.
		return frameService("protocol-error", ProtocolError{
			ProtocolVersion: ServiceProtocolVersion,
			Code:            "FRAME_ENCODE_FAILED",
			Message:         "the engine could not encode that frame",
		})
	}
	return prefix + "\t" + base64.StdEncoding.EncodeToString(raw)
}

// RequestIDFromLine reports the requestId a framed line carries, in either
// direction, so a rejection or a replaced frame can be attributed to the row
// that sent it and a duplicate command can be recognized as one.
//
// It is deliberately best-effort and read-only: the line may have failed
// validation, so nothing here may assume a schema. Only a well-formed base64
// JSON object with a string requestId yields an id.
func RequestIDFromLine(line string) string {
	prefix, encoded, found := strings.Cut(line, "\t")
	if !found {
		return ""
	}
	switch prefix {
	case "mutate", "invoke", "logs", "doctor", "backup-inspect", "model-roles",
		// Output frames: a recovery path must not answer a request twice.
		"result", "protocol-error":
	default:
		// `cancel` is deliberately absent: its requestId names the request it
		// cancels, so attributing a refused cancel to that id would settle the
		// wrong row (and release a mutation slot for work still running).
		return ""
	}
	if len(encoded) <= MaxServiceFrameBytes {
		raw, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return ""
		}
		var probe struct {
			RequestID string `json:"requestId"`
		}
		if json.Unmarshal(raw, &probe) == nil {
			return probe.RequestID
		}
	}
	// An oversized frame is the case that most needs attribution, so fall back
	// to scanning a bounded prefix of the decoded payload. A requestId is a
	// plain ASCII token in every frame this code writes.
	const probeBytes = 256 << 10
	limit := len(encoded)
	if limit > probeBytes {
		limit = probeBytes
	}
	raw, err := base64.StdEncoding.DecodeString(encoded[:limit&^3])
	if err != nil {
		return ""
	}
	const marker = `"requestId":"`
	start := bytes.Index(raw, []byte(marker))
	if start < 0 {
		return ""
	}
	rest := raw[start+len(marker):]
	end := bytes.IndexByte(rest, '"')
	if end <= 0 || end > 128 {
		return ""
	}
	return string(rest[:end])
}

// FrameSnapshot frames a snapshot for the app.
func FrameSnapshot(s *Snapshot) string { return frame("snapshot", s) }

// Result is one command result.
//
// A failure carries more than its message: Code is the stable machine string
// the CLI already exposes, Suggestions are the hints reportErr prints, and
// Mutated warns that the executor may have left state half-applied. Dropping
// them turned every app failure into one flat sentence the user could only
// react to by retrying (see Result.Fail).
type Result struct {
	Version     int             `json:"version"`
	RequestID   string          `json:"requestId"`
	Status      string          `json:"status"` // success | error | cancelled
	Message     string          `json:"message,omitempty"`
	Code        string          `json:"code,omitempty"`
	Suggestions []string        `json:"suggestions,omitempty"`
	Mutated     bool            `json:"mutated,omitempty"`
	Payload     json.RawMessage `json:"payload,omitempty"`
}

// FrameResult frames a command result for the app.
func FrameResult(r Result) string {
	r.Message = displaySafeMessage(r.Message)
	return frame("result", r)
}

// ProxyLogsResult is one proxy-log answer.
type ProxyLogsResult struct {
	Version   int    `json:"version"`
	RequestID string `json:"requestId"`
	ProxyID   string `json:"proxyId"`
	State     string `json:"state"` // ready | empty | not-running | error
	Text      string `json:"text"`
}

// FrameProxyLogs frames a proxy-log answer for the app.
func FrameProxyLogs(r ProxyLogsResult) string { return frame("logs", r) }

// DoctorResult mirrors the desktop settings diagnostics response.
type DoctorResult struct {
	Version   int              `json:"version"`
	RequestID string           `json:"requestId"`
	Status    string           `json:"status"`
	Findings  []doctor.Finding `json:"findings"`
}

func FrameDoctor(r DoctorResult) string { return frame("doctor", r) }

// BackupPreviewEntry is one backup preview row. ID is the base-36 index so
// entryIds from the native client resolve identically.
type BackupPreviewEntry struct {
	ID          string `json:"id"`
	ProviderID  string `json:"providerId"`
	Name        string `json:"name"`
	Label       string `json:"label"`
	Disposition string `json:"disposition"`
	Reason      string `json:"reason,omitempty"`
}

// BackupPreviewResult is the backup preview response (ready | error).
type BackupPreviewResult struct {
	Version      int                  `json:"version"`
	RequestID    string               `json:"requestId"`
	Status       string               `json:"status"` // ready | error
	InspectionID string               `json:"inspectionId,omitempty"`
	CreatedAt    string               `json:"createdAt,omitempty"`
	Entries      []BackupPreviewEntry `json:"entries,omitempty"`
	Error        string               `json:"error,omitempty"`
	Code         string               `json:"code,omitempty"`
	Reason       string               `json:"reason,omitempty"`
	Message      string               `json:"message,omitempty"`
}

// FrameBackupPreview frames a backup preview for the app.
func FrameBackupPreview(r BackupPreviewResult) string { return frame("backup-preview", r) }

// decodeStrictPayload base64-decodes a payload, strictly unmarshals it, and
// applies the per-kind contract validation.
func decodeStrictPayload(encoded, kind string, into interface{}) (json.RawMessage, error) {
	if encoded == "" || len(encoded) > MaxCommandBytes {
		return nil, fmt.Errorf("bad payload length")
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("bad base64: %w", err)
	}
	if err := decodeStrict(raw, into); err != nil {
		return nil, err
	}
	// Validation reads the ORIGINAL payload so explicitly-sent `false`
	// booleans count as present, matching the key-presence checks.
	if verr := validatePayload(kind, raw); verr != nil {
		return nil, verr
	}
	return raw, nil
}
