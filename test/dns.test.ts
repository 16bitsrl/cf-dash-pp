import { describe, expect, it } from "vitest";
import { cfRecordError, emptyInput, inputFromRecord, normalizeName, parseZoneFile, previewImport, RECORD_TYPES, recordChanges, recordLabel, TYPE_SPECS, validateRecord, type RecordInput } from "../src/worker/lib/dns";
import type { Rec } from "../src/worker/lib/zone-state";

const Z = "example.com";
const ok = (input: Partial<RecordInput>) => {
  const r = validateRecord(Z, { ...emptyInput("A"), ...input });
  if ("error" in r) throw new Error(`${r.error.code} ${JSON.stringify(r.error.params)}`);
  return r.body;
};
const err = (input: Partial<RecordInput>) => {
  const r = validateRecord(Z, { ...emptyInput("A"), ...input });
  if (!("error" in r)) throw new Error(`valid: ${JSON.stringify(r.body)}`);
  return r.error;
};

describe("record types", () => {
  it("are the ones the Cloudflare dashboard offers", () => {
    expect(RECORD_TYPES).toEqual(["A", "AAAA", "CAA", "CERT", "CNAME", "DNSKEY", "DS", "HTTPS", "LOC", "MX", "NAPTR", "NS", "OPENPGPKEY", "PTR", "SMIMEA", "SRV", "SSHFP", "SVCB", "TLSA", "TXT", "URI"]);
    for (const t of RECORD_TYPES) expect(TYPE_SPECS[t].content || TYPE_SPECS[t].data).toBeTruthy();
  });

  it("only A, AAAA and CNAME can be proxied", () => {
    expect(RECORD_TYPES.filter((t) => TYPE_SPECS[t].proxiable)).toEqual(["A", "AAAA", "CNAME"]);
  });
});

describe("names", () => {
  it("accept @, relative and full names, with or without the final dot", () => {
    expect(normalizeName(Z, "@")).toBe("example.com");
    expect(normalizeName(Z, "")).toBe("example.com");
    expect(normalizeName(Z, "www")).toBe("www.example.com");
    expect(normalizeName(Z, "WWW.Example.com.")).toBe("www.example.com");
    expect(normalizeName(Z, "*.dev")).toBe("*.dev.example.com");
    expect(normalizeName(Z, "_dmarc")).toBe("_dmarc.example.com");
  });

  it("turn international names into their ASCII form", () => {
    expect(normalizeName(Z, "caffè")).toBe("xn--caff-8oa.example.com");
  });

  it("refuse names that are not valid", () => {
    expect(normalizeName(Z, "a b")).toBeNull();
    expect(normalizeName(Z, "-x")).toBeNull();
    expect(normalizeName(Z, "a..b")).toBeNull();
    expect(normalizeName(Z, `${"a".repeat(64)}`)).toBeNull();
  });
});

describe("validation", () => {
  it("A: an IPv4 address, proxy and TTL", () => {
    expect(ok({ type: "A", name: "www", content: "198.51.100.4", proxied: true, ttl: 3600 })).toEqual({ type: "A", name: "www.example.com", content: "198.51.100.4", proxied: true, ttl: 1, comment: "", tags: [] });
    expect(err({ type: "A", content: "300.1.1.1" }).code).toBe("record-ipv4-invalid");
    expect(err({ type: "A", content: "" }).code).toBe("record-content-required");
  });

  it("AAAA: an IPv6 address", () => {
    expect(ok({ type: "AAAA", content: "2001:db8::1" }).content).toBe("2001:db8::1");
    expect(err({ type: "AAAA", content: "198.51.100.4" }).code).toBe("record-ipv6-invalid");
  });

  it("CNAME: a hostname that is not the record itself", () => {
    expect(ok({ type: "CNAME", name: "www", content: "target.example.net." }).content).toBe("target.example.net");
    expect(err({ type: "CNAME", name: "www", content: "www.example.com" }).code).toBe("record-cname-self");
    expect(err({ type: "CNAME", content: "not a host" }).code).toBe("record-hostname-invalid");
  });

  it("the proxy only on the types that allow it", () => {
    expect(ok({ type: "TXT", content: "hello", proxied: true }).proxied).toBeUndefined();
  });

  it("TTL: Auto or 30 seconds to one day", () => {
    expect(ok({ ttl: 1, content: "198.51.100.4" }).ttl).toBe(1);
    expect(ok({ ttl: 86400, content: "198.51.100.4" }).ttl).toBe(86400);
    expect(err({ ttl: 20, content: "198.51.100.4" }).code).toBe("record-ttl-invalid");
    expect(err({ ttl: 90000, content: "198.51.100.4" }).code).toBe("record-ttl-invalid");
  });

  it("MX: a priority and a mail server, or the null MX", () => {
    expect(ok({ type: "MX", content: "mx.example.net", priority: 10 })).toMatchObject({ content: "mx.example.net", priority: 10 });
    expect(ok({ type: "MX", content: ".", priority: 0 }).content).toBe(".");
    expect(err({ type: "MX", content: "mx.example.net", priority: 70000 }).code).toBe("record-priority-invalid");
    expect(err({ type: "MX", content: "mx.example.net", priority: undefined }).code).toBe("record-priority-invalid");
  });

  it("TXT: any text, without the limit being exceeded", () => {
    expect(ok({ type: "TXT", content: "v=spf1 -all" }).content).toBe("v=spf1 -all");
    expect(err({ type: "TXT", content: "x".repeat(5000) }).code).toBe("record-text-too-long");
  });

  it("SRV: structured fields and a service name", () => {
    const b = ok({ type: "SRV", name: "_sip._tcp", data: { priority: "10", weight: "5", port: "5060", target: "sip.example.net." } });
    expect(b).toMatchObject({ type: "SRV", name: "_sip._tcp.example.com", data: { priority: 10, weight: 5, port: 5060, target: "sip.example.net" } });
    expect(b.content).toBeUndefined();
    expect(err({ type: "SRV", name: "sip", data: { priority: "1", weight: "1", port: "1", target: "x.example.net" } }).code).toBe("record-srv-name");
    expect(err({ type: "SRV", name: "_sip._tcp", data: { priority: "1", weight: "1", port: "99999", target: "x.example.net" } })).toEqual({ code: "record-field-invalid", params: { field: "port" } });
  });

  it("CAA: flags, a known tag and a value", () => {
    expect(ok({ type: "CAA", data: { flags: "0", tag: "issue", value: "letsencrypt.org" } }).data).toEqual({ flags: 0, tag: "issue", value: "letsencrypt.org" });
    expect(err({ type: "CAA", data: { flags: "0", tag: "nope", value: "x" } })).toEqual({ code: "record-field-invalid", params: { field: "tag" } });
  });

  it("LOC: coordinates within their ranges, decimals allowed", () => {
    const data = { lat_degrees: "37", lat_minutes: "46", lat_seconds: "46.5", lat_direction: "N", long_degrees: "122", long_minutes: "23", long_seconds: "35", long_direction: "W", altitude: "0", size: "100", precision_horz: "0", precision_vert: "0" };
    expect(ok({ type: "LOC", data }).data).toMatchObject({ lat_seconds: 46.5, long_direction: "W", size: 100 });
    expect(err({ type: "LOC", data: { ...data, lat_degrees: "91" } })).toEqual({ code: "record-field-invalid", params: { field: "lat_degrees" } });
  });

  it("TLSA, SSHFP, DS: hexadecimal values", () => {
    expect(ok({ type: "TLSA", name: "_443._tcp", data: { usage: "3", selector: "1", matching_type: "1", certificate: "ABCDEF0123" } }).data).toMatchObject({ certificate: "ABCDEF0123" });
    expect(err({ type: "SSHFP", data: { algorithm: "4", type: "2", fingerprint: "zz" } })).toEqual({ code: "record-field-invalid", params: { field: "fingerprint" } });
    expect(ok({ type: "DS", data: { key_tag: "2371", algorithm: "13", digest_type: "2", digest: "1F987CC6583E92DF0890718C42" } }).data).toMatchObject({ key_tag: 2371 });
  });

  it("URI: a priority, a weight and a target", () => {
    expect(ok({ type: "URI", name: "_ftp._tcp", priority: 10, data: { weight: "1", target: "ftp://ftp.example.com/" } })).toMatchObject({ priority: 10, data: { weight: 1, target: "ftp://ftp.example.com/" } });
  });

  it("HTTPS and SVCB: priority, target and parameters", () => {
    expect(ok({ type: "HTTPS", data: { priority: "1", target: ".", value: 'alpn="h3,h2"' } }).data).toEqual({ priority: 1, target: ".", value: 'alpn="h3,h2"' });
  });

  it("comment: one line, at most 500 characters", () => {
    expect(ok({ content: "198.51.100.4", comment: "  web server " }).comment).toBe("web server");
    expect(err({ content: "198.51.100.4", comment: "a\nb" }).code).toBe("record-comment-invalid");
    expect(err({ content: "198.51.100.4", comment: "x".repeat(501) }).code).toBe("record-comment-invalid");
  });

  it("tags: name:value, at most 20", () => {
    expect(ok({ content: "198.51.100.4", tags: ["team:dns", " env:prod "] }).tags).toEqual(["team:dns", "env:prod"]);
    expect(err({ content: "198.51.100.4", tags: ["bad name:x"] })).toEqual({ code: "record-tag-invalid", params: { tag: "bad name:x" } });
    expect(err({ content: "198.51.100.4", tags: Array.from({ length: 21 }, (_, i) => `t${i}:x`) }).code).toBe("record-tags-too-many");
  });

  it("settings: flattening only on CNAME, IPv4 or IPv6 only on proxied A and AAAA", () => {
    expect(ok({ type: "CNAME", name: "www", content: "x.example.net", settings: { flatten_cname: true } }).settings).toEqual({ flatten_cname: true });
    expect(ok({ type: "A", content: "198.51.100.4", proxied: true, settings: { ipv4_only: true, flatten_cname: true } }).settings).toEqual({ ipv4_only: true, ipv6_only: false });
    expect(ok({ type: "A", content: "198.51.100.4", proxied: false, settings: { ipv4_only: true } }).settings).toBeUndefined();
    expect(err({ type: "A", content: "198.51.100.4", proxied: true, settings: { ipv4_only: true, ipv6_only: true } }).code).toBe("record-ip-only-both");
  });

  it("an unknown type", () => {
    expect(err({ type: "SPF" }).code).toBe("record-type-invalid");
  });
});

const rec = (r: Partial<Rec>): Rec => ({ id: "r1", type: "A", name: "www.example.com", content: "198.51.100.4", proxied: false, ttl: 1, comment: null, tags: [], ...r });

describe("old and new values", () => {
  it("list only what changes", () => {
    const before = rec({ comment: "old" });
    const body = ok({ type: "A", name: "www", content: "198.51.100.5", proxied: true, comment: "old" });
    expect(recordChanges(before, body)).toEqual([
      { field: "content", before: "198.51.100.4", after: "198.51.100.5" },
      { field: "proxied", before: "false", after: "true" },
    ]);
    expect(recordChanges(before, ok({ type: "A", name: "www", content: "198.51.100.4", comment: "old" }))).toEqual([]);
  });

  it("compare structured fields one by one", () => {
    const before = rec({ type: "SRV", name: "_sip._tcp.example.com", content: "5 5060 sip.example.net", priority: 10, data: { priority: 10, weight: 5, port: 5060, target: "sip.example.net" } });
    const body = ok({ type: "SRV", name: "_sip._tcp", data: { priority: "10", weight: "5", port: "5061", target: "sip.example.net" } });
    expect(recordChanges(before, body)).toEqual([{ field: "port", before: "5060", after: "5061" }]);
  });

  it("the form of a record gives the same record back", () => {
    const r = rec({ type: "MX", name: "example.com", content: "mx.example.net", priority: 10, ttl: 3600, comment: "mail", tags: ["a:b"] });
    const input = inputFromRecord(Z, r);
    expect(input.name).toBe("@");
    expect(recordChanges(r, ok(input))).toEqual([]);
  });

  it("a short label for lists", () => {
    expect(recordLabel(rec({ type: "MX", content: "mx.example.net", priority: 10 }))).toBe("MX www.example.com 10 mx.example.net");
  });
});

describe("Cloudflare errors", () => {
  it("map to specific codes", () => {
    expect(cfRecordError([{ code: 81058, message: "An identical record already exists." }])).toEqual({ code: "record-duplicate", params: {} });
    expect(cfRecordError([{ code: 81057, message: "Record already exists." }])?.code).toBe("record-duplicate");
    expect(cfRecordError([{ code: 81053, message: "An A, AAAA, or CNAME record with that host already exists." }])?.code).toBe("record-host-taken");
    expect(cfRecordError([{ code: 9300, message: "DNS record has 1 tags, exceeding the quota of 0." }])?.code).toBe("record-tags-unavailable");
    expect(cfRecordError([{ code: 9226, message: "CNAME flattening is not available to this zone." }])?.code).toBe("record-flatten-unavailable");
    expect(cfRecordError([{ code: 9227, message: "The IPv4 Only and IPv6 Only settings are not available to this zone." }])?.code).toBe("record-ip-only-unavailable");
    expect(cfRecordError([{ code: 9313, message: "DNS record comment exceeds the maximum length of 100 characters." }])).toEqual({ code: "record-comment-too-long", params: { max: 100 } });
    expect(cfRecordError([{ code: 9004, message: "This record type cannot be proxied." }])?.code).toBe("record-not-proxiable");
    expect(cfRecordError([{ code: 81044, message: "Record does not exist." }])?.code).toBe("record-not-found");
    expect(cfRecordError([{ code: 9005, message: "Content for A record must be a valid IPv4 address." }])).toEqual({ code: "record-invalid", params: { message: "Content for A record must be a valid IPv4 address." } });
    expect(cfRecordError([{ code: 10000, message: "Authentication error" }])).toBeNull();
  });
});

const ZONE_FILE = `;; Exported
$ORIGIN example.com.
$TTL 3600
example.com.	3600	IN	SOA	ns.cloudflare.com. dns.cloudflare.com. 2054556799 10000 2400 604800 3600
@	86400	IN	NS	ray.ns.cloudflare.com.
www	300	IN	A	198.51.100.4 ; web cf_tags=cf-proxied:true
	IN	AAAA	2001:db8::1
mail.example.com.	1	IN	MX	10 mx.example.net.
txt	IN	TXT	"v=spf1 include:_spf.example.net" " -all"
_sip._tcp	SRV	10 5 5060 sip.example.net.
multi	IN	CAA	( 0 issue
	"letsencrypt.org" )
bad line here
`;

describe("zone files", () => {
  it("read records with origin, default TTL, repeated names and multi-line values", () => {
    const { records, errors } = parseZoneFile(ZONE_FILE, Z);
    expect(records.map((r) => [r.type, r.name, r.content, r.ttl, r.priority ?? null])).toEqual([
      ["NS", "example.com", "ray.ns.cloudflare.com", 86400, null],
      ["A", "www.example.com", "198.51.100.4", 300, null],
      ["AAAA", "www.example.com", "2001:db8::1", 3600, null],
      ["MX", "mail.example.com", "mx.example.net", 1, 10],
      ["TXT", "txt.example.com", "v=spf1 include:_spf.example.net -all", 3600, null],
      ["SRV", "_sip._tcp.example.com", "5 5060 sip.example.net", 3600, 10],
      ["CAA", "multi.example.com", '0 issue "letsencrypt.org"', 3600, null],
    ]);
    expect(records[1].proxied).toBe(true);
    expect(errors).toEqual([{ line: 13, text: "bad line here" }]);
  });

  it("show what is new, what is already there and what conflicts", () => {
    // A CNAME can't share its name with other records; A and AAAA can share theirs.
    const { records } = parseZoneFile(ZONE_FILE, Z);
    const existing = [
      rec({ id: "e1", type: "A", name: "www.example.com", content: "198.51.100.4" }),
      rec({ id: "e2", type: "CNAME", name: "mail.example.com", content: "x.example.net" }),
      rec({ id: "e3", type: "TXT", name: "txt.example.com", content: '"v=spf1 include:_spf.example.net -all"' }),
    ];
    const p = previewImport(Z, existing, [...records, { ...records[1] }]);
    expect(p.same.map((r) => `${r.type} ${r.name}`)).toEqual(["A www.example.com", "TXT txt.example.com", "A www.example.com"]);
    expect(p.conflicts.map((c) => `${c.record.type} ${c.record.name} ${c.with.map((w) => w.id)}`)).toEqual(["MX mail.example.com e2"]);
    expect(p.add.map((r) => `${r.type} ${r.name}`)).toEqual(["NS example.com", "AAAA www.example.com", "SRV _sip._tcp.example.com", "CAA multi.example.com"]);
  });
});
