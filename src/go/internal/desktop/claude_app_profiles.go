package desktop

import (
	"context"
	"fmt"
	"strings"

	"github.com/outof0/anypick/go/internal/activation"
	"github.com/outof0/anypick/go/internal/client"
)

// ClaudeAppProfileRow describes one separate Claude app data folder. SignedIn
// comes from a non-secret field; nothing here identifies the account.
type ClaudeAppProfileRow struct {
	Name     string `json:"name"`
	SignedIn bool   `json:"signedIn"`
	Running  bool   `json:"running"`
}

func (b *snapshotBuilder) claudeAppProfiles() {
	if b == nil || b.srv == nil {
		return
	}
	b.snap.ClaudeAppProfiles = []ClaudeAppProfileRow{}
	b.snap.ClaudeAppSupported = client.ClaudeAppProfileSupported()
	profiles, err := client.ListClaudeAppProfiles(b.srv.Deps.Root)
	if err != nil {
		b.srv.logErr(fmt.Errorf("read Claude app profiles for snapshot: %w", err))
		return
	}
	for _, profile := range profiles {
		b.snap.ClaudeAppProfiles = append(b.snap.ClaudeAppProfiles, ClaudeAppProfileRow{
			Name: profile.Name, SignedIn: profile.SignedIn, Running: profile.Running,
		})
	}
}

// refreshesWhenRefused marks operations whose refusal means the host's snapshot
// is stale. Service mode sends snapshots only after a mutation, and nothing
// reports a Claude app window being quit, so a refused open or remove is what
// corrects a row that still reads as open or closed.
func refreshesWhenRefused(operation string) bool {
	return strings.HasPrefix(operation, "claude-app-profile-")
}

// routeClaudeAppProfileMutation dispatches the claude-app-profile-* operations
// that routeMutation hands over as one group.
func (s *Server) routeClaudeAppProfileMutation(ctx context.Context, m Mutate, result Result) Result {
	if m.Operation == "claude-app-profile-open" {
		if err := activation.OpenClaudeAppProfile(ctx, s.Deps.Root, m.Name); err != nil {
			return result.Fail(err)
		}
		result.Message = fmt.Sprintf("Opened Claude app profile %s.", m.Name)
		return result
	}
	if err := activation.RemoveClaudeAppProfile(ctx, s.Deps.Root, m.Name); err != nil {
		return result.Fail(err)
	}
	result.Message = fmt.Sprintf("Removed Claude app profile %s.", m.Name)
	return result
}
