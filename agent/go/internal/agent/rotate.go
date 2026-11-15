package agent

import (
	"context"

	"observaone/agent/internal/core"
)

// rotateCredential asks the server for a new credential (when the heartbeat answer says rotate: true: the
// credential is old, or an admin asked for it). Order matters, so the agent can never lock itself out:
//
//  1. the server issues the new credential and keeps accepting the old one;
//  2. the agent saves the new one to disk (atomic) and only then starts using it;
//  3. the server stops accepting the old one 10 minutes after the new one is first used.
//
// If saving fails, the agent keeps using the old credential and the server simply asks again later.
func (a *Agent) rotateCredential(ctx context.Context) {
	a.mu.Lock()
	cl, cred, id := a.client, a.cred, a.id
	a.mu.Unlock()
	var ans struct {
		Credential string `json:"credential"`
	}
	if err := cl.PostJSON(ctx, core.AgentPath(id.AgentID, "credential/rotate"), cred, map[string]any{}, &ans); err != nil {
		a.Log.Warn("credential rotation failed; keeping the current credential", "error", err.Error())
		return
	}
	if !core.ValidCredential(ans.Credential, id.AgentID) {
		a.Log.Error("credential rotation: the server sent something that is not a credential for this agent; keeping the current one")
		return
	}
	if err := core.SaveIdentity(a.Config().StateDir, id, ans.Credential); err != nil {
		a.Log.Error("credential rotation: cannot save the new credential; keeping the current one", "error", err.Error())
		return
	}
	a.mu.Lock()
	a.cred = ans.Credential
	a.mu.Unlock()
	a.Log.Info("credential rotated (the old one stops working 10 minutes after the new one is first used)")
}
