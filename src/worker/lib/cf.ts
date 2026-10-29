// Minimal Cloudflare API client. Every call uses the caller's token: the user's (OAuth) for
// what they see and change, the service token for the background sync.

export class CfError extends Error {
  constructor(
    public status: number,
    public errors: { code: number; message: string }[],
  ) {
    super(errors.map((e) => e.message).join("; ") || `HTTP ${status}`);
  }
  get forbidden() {
    return this.status === 403 || this.errors.some((e) => e.code === 10000 || e.code === 9109);
  }
  get notFound() {
    return this.status === 404;
  }
}

type Envelope<T> = {
  success: boolean;
  result: T;
  errors: { code: number; message: string }[];
  result_info?: { page: number; per_page: number; total_pages?: number; count: number; total_count?: number };
};

export class CfApi {
  constructor(
    private token: string,
    private base = "https://api.cloudflare.com/client/v4",
  ) {}

  async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw<T>(method, path, body);
    return res.result;
  }

  private async raw<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !json?.success) throw new CfError(res.status, json?.errors ?? []);
    return json;
  }

  async form<T>(method: string, path: string, body: FormData): Promise<T> {
    const res = await fetch(this.base + path, { method, headers: { authorization: `Bearer ${this.token}` }, body });
    const json = (await res.json().catch(() => null)) as Envelope<T> | null;
    if (!res.ok || !json?.success) throw new CfError(res.status, json?.errors ?? []);
    return json.result;
  }

  /** A response that is not JSON (such as a Worker's content), null if not found. */
  async fetch(path: string): Promise<Response | null> {
    const res = await fetch(this.base + path, { headers: { authorization: `Bearer ${this.token}` } });
    if (res.status === 404) return null;
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as Envelope<unknown> | null;
      throw new CfError(res.status, json?.errors ?? []);
    }
    return res;
  }

  /** Every page of a list. */
  async all<T>(path: string, perPage = 100): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page < 100; page++) {
      const res = await this.raw<T[]>("GET", `${path}${sep}page=${page}&per_page=${perPage}`);
      out.push(...res.result);
      const info = res.result_info;
      if (!info || res.result.length < perPage || (info.total_pages && page >= info.total_pages)) break;
    }
    return out;
  }
}

export type Account = { id: string; name: string };
export type Zone = { id: string; name: string; status: string; account: { id: string; name: string }; name_servers?: string[]; plan?: { name: string }; paused?: boolean };
