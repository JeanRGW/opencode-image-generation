export async function request(url: URL, init: RequestInit, operation: string) {
  try {
    const response = await fetch(url, { ...init, redirect: "error" });
    if (!response.ok) await response.body?.cancel();
    return response;
  } catch {
    if (init.signal?.aborted) {
      const timeout = init.signal.reason instanceof Error && init.signal.reason.name === "TimeoutError";
      throw new Error(`${operation} ${timeout ? "failed (timeout)" : "was aborted"}.`);
    }
    // Fetch errors can include signed URLs, credentials, or provider internals.
    throw new Error(`${operation} failed: network, TLS, or redirect error.`);
  }
}

export async function readBytes(response: Response, limit: number, operation: string) {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > limit) {
    await response.body?.cancel();
    throw new Error(`${operation} exceeds the configured byte limit.`);
  }
  if (!response.body) throw new Error(`${operation} has an empty body.`);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error(`${operation} exceeds the configured byte limit.`);
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof Error && error.message === `${operation} exceeds the configured byte limit.`) throw error;
    throw new Error(`${operation} could not be read (network failure, timeout, or cancellation).`);
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

export async function readJSON(response: Response, limit: number) {
  const bytes = await readBytes(response, limit, "API response");
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("API response is not valid JSON.");
  }
}
