export class TargetState {
  constructor() { this.revision = 0; this.invalidate(); }
  invalidate() {
    this.revision++;
    this.config = null;
    this.fileTargets = [];
    this.draft = [];
    this.source = 'file';
    this.confirmed = null;
    this.dirty = true;
  }
  load(config, targets) {
    this.invalidate();
    this.config = config;
    this.fileTargets = structuredClone(targets);
    this.draft = structuredClone(targets);
  }
  fill(targets, source) {
    this.draft = structuredClone(targets);
    this.source = source;
    this.touch();
  }
  restore() { this.fill(this.fileTargets, 'file'); }
  touch() { this.dirty = true; this.revision++; }
  snapshot(targets) {
    return { config: this.config, targets: structuredClone(targets), source: this.source, revision: this.revision };
  }
  confirm(snapshot, response) {
    if (snapshot.revision !== this.revision || snapshot.config !== this.config) return false;
    this.draft = structuredClone(snapshot.targets);
    this.confirmed = structuredClone(response);
    this.dirty = false;
    return true;
  }
  get canRun() { return !!this.config && !!this.confirmed && !this.dirty; }
}
