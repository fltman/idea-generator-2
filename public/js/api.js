// Fetch wrapper and the live event stream for a board.

export async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const isJson = res.headers.get('content-type')?.includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((isJson && data?.error) || res.statusText);
    err.code = isJson ? data?.code : 'http_' + res.status;
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Follow everything that happens on a board. Returns a function that stops following. */
export function follow(boardId, onEvent) {
  const es = new EventSource(`/api/boards/${boardId}/events`);
  es.onmessage = (m) => {
    try {
      const e = JSON.parse(m.data);
      // A deleted board's id can go to the next board created: never reconnect to it.
      if (e.type === 'deleted') es.close();
      onEvent(e);
    } catch (e) {
      console.error('bad event', e);
    }
  };
  return () => es.close();
}
