// @vitest-environment node

import { describe, expect, it } from "vitest";

describe("createAccessGate", () => {
  it("allows when token is unset", async () => {
    const { createAccessGate } = await import("../../server/access-gate");
    const gate = createAccessGate({ token: "" });
    expect(gate.allowUpgrade({ headers: {} })).toBe(true);
  });

  it("rejects /api requests without cookie when enabled", async () => {
    const { createAccessGate } = await import("../../server/access-gate");
    const gate = createAccessGate({ token: "abc" });

    let statusCode = 0;
    let ended = false;
    const res = {
      setHeader: () => {},
      end: () => {
        ended = true;
      },
      get statusCode() {
        return statusCode;
      },
      set statusCode(value: number) {
        statusCode = value;
      },
    };

    const handled = gate.handleHttp(
      { url: "/api/studio", headers: { host: "example.test" } },
      res
    );

    expect(handled).toBe(true);
    expect(statusCode).toBe(401);
    expect(ended).toBe(true);
  });

  it("allows upgrades when cookie matches", async () => {
    const { createAccessGate } = await import("../../server/access-gate");
    const gate = createAccessGate({ token: "abc" });
    expect(
      gate.allowUpgrade({ headers: { cookie: "studio_access=abc" } })
    ).toBe(true);
  });

  it("returns 429 after repeated failed attempts", async () => {
    const { createAccessGate } = await import("../../server/access-gate");
    const gate = createAccessGate({ token: "abc" });

    const createResponse = () => {
      let statusCode = 0;
      let body = "";
      return {
        setHeader: () => {},
        end: (value?: string) => {
          body = value ?? "";
        },
        get statusCode() {
          return statusCode;
        },
        set statusCode(value: number) {
          statusCode = value;
        },
        get body() {
          return body;
        },
      };
    };

    for (let index = 0; index < 9; index++) {
      const res = createResponse();
      gate.handleHttp(
        { url: "/api/studio", headers: {}, socket: { remoteAddress: "127.0.0.1" } },
        res
      );
      expect(res.statusCode).toBe(401);
    }

    const limited = createResponse();
    gate.handleHttp(
      { url: "/api/studio", headers: {}, socket: { remoteAddress: "127.0.0.1" } },
      limited
    );

    expect(limited.statusCode).toBe(429);
    expect(limited.body).toContain("Too many failed studio access attempts");
  });

  it("recovers immediately when a valid cookie is sent after throttling", async () => {
    const { createAccessGate } = await import("../../server/access-gate");
    const gate = createAccessGate({ token: "abc" });

    const createResponse = () => {
      let statusCode = 0;
      let body = "";
      return {
        setHeader: () => {},
        end: (value?: string) => {
          body = value ?? "";
        },
        get statusCode() {
          return statusCode;
        },
        set statusCode(value: number) {
          statusCode = value;
        },
        get body() {
          return body;
        },
      };
    };

    for (let index = 0; index < 10; index++) {
      const res = createResponse();
      gate.handleHttp(
        { url: "/api/studio", headers: {}, socket: { remoteAddress: "127.0.0.1" } },
        res
      );
    }

    expect(
      gate.allowUpgrade({
        headers: { cookie: "studio_access=abc" },
        socket: { remoteAddress: "127.0.0.1" },
      })
    ).toBe(true);

    const recovered = createResponse();
    gate.handleHttp(
      {
        url: "/api/studio",
        headers: { cookie: "studio_access=abc" },
        socket: { remoteAddress: "127.0.0.1" },
      },
      recovered
    );

    expect(recovered.statusCode).toBe(0);

    const afterReset = createResponse();
    gate.handleHttp(
      { url: "/api/studio", headers: {}, socket: { remoteAddress: "127.0.0.1" } },
      afterReset
    );

    expect(afterReset.statusCode).toBe(401);
    expect(afterReset.body).toContain("Studio access token required");
  });

  it("logs in via ?token= by setting the cookie and redirecting to a clean URL", async () => {
    const { createAccessGate } = await import("../../server/access-gate");
    const gate = createAccessGate({ token: "abc" });
    const headers: Record<string, string> = {};
    const res = { statusCode: 0, body: "", setHeader: (k: string, v: string) => { headers[k] = v; }, end: (v?: string) => { res.body = v ?? ""; } };

    expect(gate.handleHttp({ url: "/office?x=1&token=abc", headers: {}, socket: { remoteAddress: "10.0.0.1" } }, res)).toBe(true);
    expect(res.statusCode).toBe(303);
    expect(headers.Location).toBe("/office?x=1");
    expect(headers["Set-Cookie"]).toMatch(/^studio_access=abc; Path=\/; HttpOnly/);
  });

  it("shows the login form on a wrong ?token= and never on /api", async () => {
    const { createAccessGate } = await import("../../server/access-gate");
    const gate = createAccessGate({ token: "abc" });
    const mk = () => { const r = { statusCode: 0, body: "", setHeader: () => {}, end: (v?: string) => { r.body = v ?? ""; } }; return r; };

    const wrong = mk();
    gate.handleHttp({ url: "/?token=nope", headers: {}, socket: { remoteAddress: "10.0.0.2" } }, wrong);
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toContain("Invalid access token.");
    expect(wrong.body).toContain('<input id="token" name="token"');

    const api = mk();
    gate.handleHttp({ url: "/api/studio?token=abc", headers: {}, socket: { remoteAddress: "10.0.0.3" } }, api);
    expect(api.statusCode).toBe(401);
  });

  describe("username/password login", () => {
    // Hash made with Python hashlib.scrypt(n=16384, r=8, p=1, dklen=32) — same as set-login.sh.
    const HASH = "scrypt:3bc378fb4df224101ed8618afc630cb4:bd4035db04ef0c878edd8f79a8867e5860b776a306092669f12e48107f4fc574";
    const post = async (gate: ReturnType<typeof import("../../server/access-gate").createAccessGate>, body: string, ip = "10.1.0.1") => {
      const { Readable } = await import("node:stream");
      const req = Object.assign(Readable.from([body]), { method: "POST", url: "/__studio-login", headers: {}, socket: { remoteAddress: ip } });
      return new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve) => {
        const headers: Record<string, string> = {};
        const res = { statusCode: 0, setHeader: (k: string, v: string) => { headers[k] = v; }, end: (b?: string) => resolve({ status: res.statusCode, headers, body: b ?? "" }) };
        expect(gate.handleHttp(req, res)).toBe(true);
      });
    };
    const makeGate = async () => {
      const { createAccessGate } = await import("../../server/access-gate");
      return createAccessGate({ token: "abc", loginUser: "wahyu", loginPasswordHash: HASH });
    };

    it("shows the username/password form instead of the token form", async () => {
      const gate = await makeGate();
      const res = { statusCode: 0, body: "", setHeader: () => {}, end: (v?: string) => { res.body = v ?? ""; } };
      gate.handleHttp({ url: "/office?token=x", headers: {}, socket: { remoteAddress: "10.1.0.9" } }, res);
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain('name="username"');
      expect(res.body).toContain('value="/office"');
      expect(res.body).not.toContain('name="token"');
    });

    it("sets the session cookie and redirects on valid credentials", async () => {
      const r = await post(await makeGate(), "username=wahyu&password=correct+horse&next=%2Foffice");
      expect(r.status).toBe(303);
      expect(r.headers.Location).toBe("/office");
      expect(r.headers["Set-Cookie"]).toMatch(/^studio_access=abc; Path=\/; HttpOnly/);
    });

    it("rejects bad credentials and never redirects off-site", async () => {
      const gate = await makeGate();
      const bad = await post(gate, "username=wahyu&password=nope&next=%2Foffice");
      expect(bad.status).toBe(401);
      expect(bad.body).toContain("Invalid username or password.");
      expect(bad.headers["Set-Cookie"]).toBeUndefined();
      const wrongUser = await post(gate, "username=root&password=correct+horse");
      expect(wrongUser.status).toBe(401);
      const offsite = await post(gate, "username=wahyu&password=correct+horse&next=%2F%2Fevil.example", "10.1.0.2");
      expect(offsite.headers.Location).toBe("/");
    });
  });
});

