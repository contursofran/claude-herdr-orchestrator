"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.oneLine = oneLine;
// The row's text with the engine's framing ("The herdr-agents plugin sent a
// message:" and the closing note) left out: from the first <herdr-...> tag on.
function payload(text) {
    var at = text.indexOf('<herdr-');
    return at < 0 ? undefined : text.slice(at);
}
function attr(tag, name) {
    var _a;
    return (_a = tag.match(new RegExp("".concat(name, "=\"([^\"]*)\"")))) === null || _a === void 0 ? void 0 : _a[1];
}
// The wrap-up note, that a prompt with a worker's report ends with.
function workerNote(body) {
    var _a;
    var wrap = body.match(/\[Wrapping up: (?:(\d+) workers? still out|every worker has finished)/);
    return wrap ? " \u00B7 wrapping up, ".concat((_a = wrap[1]) !== null && _a !== void 0 ? _a : 0, " left") : '';
}
// One element's line, from its tag (its first line) on, or undefined for a tag it doesn't know.
// `note` is the worker note; a worker's line shows it.
function element(part, note) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j;
    var lines = part.split('\n');
    var tag = lines[0];
    var inner = lines
        .slice(1)
        .map(function (l) { return l.trim(); })
        .filter(function (l) { return l && !l.startsWith('</herdr-'); });
    if (tag.startsWith('<herdr-agent ')) {
        var first = (_a = inner.find(function (l) { return !l.startsWith('['); })) !== null && _a !== void 0 ? _a : '';
        var full = inner.some(function (l) { return l.startsWith('[Full report'); }) ? ' · full report in file' : '';
        var pr = attr(tag, 'pr');
        var prs = pr ? " \u00B7 PR #".concat(pr.split(',').join(', #')) : '';
        return "\u21E0 ".concat((_b = attr(tag, 'name')) !== null && _b !== void 0 ? _b : 'worker', " ").concat((_d = (_c = attr(tag, 'result')) !== null && _c !== void 0 ? _c : attr(tag, 'status')) !== null && _d !== void 0 ? _d : '', ": ").concat(first).concat(full).concat(prs).concat(note);
    }
    // Single-line forms: <herdr-decision ...>text</herdr-decision>, <herdr-context ...>text...
    var text1 = tag
        .replace(/^<herdr-[a-z]+[^>]*>/, '')
        .replace(/<\/herdr-[a-z]+>$/, '')
        .trim() ||
        inner[0] ||
        '';
    if (tag.startsWith('<herdr-decision ')) {
        var chose = (_e = inner
            .find(function (l) { return l.startsWith('The owner chose:'); })) === null || _e === void 0 ? void 0 : _e.slice(16).trim();
        var question = (_f = inner
            .find(function (l) { return l.startsWith('Question:'); })) === null || _f === void 0 ? void 0 : _f.slice(9).trim();
        return chose ? "\u25C6 ".concat((_g = attr(tag, 'id')) !== null && _g !== void 0 ? _g : '', " owner chose: ").concat(chose, " \u00B7 ").concat(question !== null && question !== void 0 ? question : '') : "\u25C6 ".concat(text1);
    }
    if (tag.startsWith('<herdr-owner-done ')) {
        var did = (_h = inner
            .find(function (l) { return l.startsWith('The owner ticked off:'); })) === null || _h === void 0 ? void 0 : _h.slice(21).trim();
        return "\u2713 ".concat((_j = attr(tag, 'id')) !== null && _j !== void 0 ? _j : '', " owner did: ").concat(did !== null && did !== void 0 ? did : text1);
    }
    if (tag.startsWith('<herdr-context'))
        return "\u21BB herdr-agents: ".concat(text1);
    return undefined;
}
// One line for a herdr-agents prompt, or undefined to keep the engine's row. A batch (see
// outbox.ts) is several elements: one line for each, and the worker note once after them.
function oneLine(text) {
    var body = payload(text);
    if (!body)
        return undefined;
    var parts = body.split(/\n(?=<herdr-)/);
    var note = workerNote(body);
    if (parts.length === 1)
        return element(body, note);
    var lines = parts.map(function (part) { var _a; return ((_a = element(part, '')) !== null && _a !== void 0 ? _a : part.split('\n')[0]).replace(/^⇠ /, ''); });
    return "\u21E0 ".concat(parts.length, " updates: ").concat(lines.join(' · ')).concat(note);
}
