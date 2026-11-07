/* Data access layer. Components never call fetch() directly.
 * RestDataProvider talks to the FastAPI backend. For Dynamics 365, implement the same
 * methods on top of Xrm.WebApi / Dataverse custom APIs and assign it to window.CQA.provider. */
(function () {
  class RestDataProvider {
    constructor(base = "") { this.base = base; }
    async _req(path, opts = {}) {
      const r = await fetch(this.base + path, {
        headers: { "Content-Type": "application/json" }, ...opts,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const ct = r.headers.get("content-type") || "";
      const data = ct.includes("json") ? await r.json() : await r.text();
      if (!r.ok) throw new Error((data && data.detail) || r.statusText);
      return data;
    }
    health() { return this._req("/api/health"); }
    groups() { return this._req("/api/groups"); }
    fetchGroup(g) { return this._req(`/api/datasets/${encodeURIComponent(g)}/fetch`, { method: "POST" }); }
    conversations(group, version) {
      const p = new URLSearchParams();
      if (group) p.set("group_id", group);
      if (version) p.set("version", version);
      return this._req(`/api/conversations?${p}`);
    }
    conversation(key, version) {
      return this._req(`/api/conversations/${encodeURIComponent(key)}` + (version ? `?version=${version}` : ""));
    }
    audioUrl(key) { return `${this.base}/api/audio/${encodeURIComponent(key)}`; }
    evaluation(id) { return this._req(`/api/evaluations/${id}`); }
    evaluate(body) { return this._req("/api/evaluate", { method: "POST", body }); }
    job(id) { return this._req(`/api/jobs/${id}`); }
    checklists() { return this._req("/api/checklists"); }
    checklist(v) { return this._req(`/api/checklists/${v || "latest"}`); }
    saveChecklist(checklist, note) { return this._req("/api/checklists", { method: "POST", body: { checklist, note } }); }
    appeal(evalId, criterion_id, comment) {
      return this._req(`/api/evaluations/${evalId}/appeals`, { method: "POST", body: { criterion_id, comment } });
    }
    appeals(status) { return this._req("/api/appeals" + (status ? `?status=${status}` : "")); }
    decide(id, body) { return this._req(`/api/appeals/${id}/decision`, { method: "POST", body }); }
    budget() { return this._req("/api/budget"); }
    metrics() { return this._req("/metrics.json").catch(() => null); }
    experiments() { return this._req("/experiments.json").catch(() => null); }
    analytics(group, version) {
      const p = new URLSearchParams();
      if (group) p.set("group_id", group);
      if (version) p.set("version", version);
      return this._req(`/api/analytics?${p}`);
    }
    peaks(key) { return this._req(`/api/audio/${encodeURIComponent(key)}/peaks`); }
  }
  window.CQA = window.CQA || {};
  window.CQA.provider = new RestDataProvider();
  window.CQA.RestDataProvider = RestDataProvider;
})();
