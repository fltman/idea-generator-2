// Keep late HTTP responses from reopening a cancelled sign-in window.
export function signInFlow(api, openWindow, changed) {
  let starting = null, popup = null, busy = false, cancelling = false, attemptId = null;
  return {
    get busy() { return busy; },
    async start(accountId, consent = false) {
      if (busy) return;
      popup = openWindow();
      if (!popup) throw new Error('Allow the sign-in popup and try again.');
      popup.opener = null;
      busy = true; changed();
      starting = api('POST', '/api/chatgpt/start', { accountId, consent });
      try {
        const result = await starting;
        attemptId = result.attemptId;
        if (!cancelling && popup && !popup.closed) popup.location.replace(result.url);
        else if (!cancelling) await this.cancel();
      } catch (e) { popup?.close(); throw e; }
      finally { starting = null; if (!cancelling) { busy = false; changed(); } }
    },
    async cancel(pendingId) {
      if (cancelling) return;
      cancelling = true; busy = true; popup?.close(); changed();
      try {
        const result = await starting?.catch(() => null);
        const id = result?.attemptId ?? attemptId ?? pendingId;
        if (id) await api('POST', '/api/chatgpt/cancel', { attemptId: id });
      } finally { popup = null; attemptId = null; cancelling = false; busy = false; changed(); }
    },
    popupClosed() { return !!popup?.closed; },
  };
}
