const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type LocalOriginFailure = {
  category: "local_only" | "invalid_host" | "cross_origin";
  message: string;
};

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function localOriginFailure(request: Request, mutation: boolean): LocalOriginFailure | null {
  const url = new URL(request.url);
  if (!isLoopback(url.hostname)) {
    return { category: "local_only", message: "The workbench API is available only on loopback." };
  }

  const host = request.headers.get("host");
  const acceptedOrigins = new Set([url.origin]);
  if (host) {
    let hostUrl: URL;
    try {
      hostUrl = new URL(`${url.protocol}//${host}`);
    } catch {
      return { category: "invalid_host", message: "The workbench request host is invalid." };
    }
    if (
      !isLoopback(hostUrl.hostname) ||
      hostUrl.username !== "" ||
      hostUrl.password !== "" ||
      hostUrl.pathname !== "/" ||
      hostUrl.search !== "" ||
      hostUrl.hash !== "" ||
      (url.port !== "" && hostUrl.port !== "" && url.port !== hostUrl.port)
    ) {
      return { category: "invalid_host", message: "The workbench request host did not match a local URL." };
    }
    acceptedOrigins.add(hostUrl.origin);
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return { category: "cross_origin", message: "The workbench API accepts same-origin requests only." };
  }

  if (mutation) {
    const rawOrigin = request.headers.get("origin");
    if (!rawOrigin) {
      return { category: "cross_origin", message: "A same-origin request is required." };
    }
    try {
      if (!acceptedOrigins.has(new URL(rawOrigin).origin)) throw new Error("origin mismatch");
    } catch {
      return { category: "cross_origin", message: "A same-origin request is required." };
    }
  }
  return null;
}
