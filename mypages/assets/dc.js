/* Tiny runtime for the My Pages pages: renders {{holes}}, <sc-if>, <sc-for> and
   <dc-import> from a <template>, re-renders on setState, and patches the DOM with morphdom. */
(function () {
  "use strict";
  var HOLE = /\{\{\s*([^}]*?)\s*\}\}/g;
  var ONE_HOLE = /^\{\{\s*([^}]*?)\s*\}\}$/;
  var BOOL_ATTRS = { disabled: 1, checked: 1, hidden: 1, readonly: 1, selected: 1, open: 1, required: 1, multiple: 1 };
  var defs = {};
  var uid = 0;

  function DCLogic(props) { this.props = props || {}; this.state = {}; }
  DCLogic.prototype.setState = function (patch, cb) {
    var inst = this.__dc;
    var next = typeof patch === "function" ? patch(this.state, this.props) : patch;
    if (next) this.state = Object.assign({}, this.state, next);
    if (cb) (inst ? inst.after : []).push(cb.bind(this));
    if (inst) inst.schedule();
  };

  function define(name, factory) { defs[name] = factory; }

  function lookup(path, scope) {
    if (path === "true") return true;
    if (path === "false") return false;
    var parts = path.split(".");
    var v = scope.hasOwnProperty(parts[0]) ? scope[parts[0]] : undefined;
    for (var i = 1; i < parts.length && v != null; i++) v = v[parts[i]];
    return v;
  }
  function str(v) { return v == null || v === false ? "" : String(v); }
  function interp(text, scope) {
    return text.replace(HOLE, function (_, p) { return str(lookup(p, scope)); });
  }

  function Instance(name, props, host) {
    var def = defs[name];
    if (!def) throw new Error("Unknown component " + name);
    this.id = ++uid;
    this.name = name;
    this.tpl = document.getElementById("dc-tpl-" + name).content;
    var defaults = def.defaults || {};
    var p = {};
    Object.keys(defaults).forEach(function (k) { p[k] = defaults[k]; });
    Object.keys(props || {}).forEach(function (k) { p[k] = props[k]; });
    var Cls = def.factory(DCLogic);
    this.comp = new Cls(p);
    this.comp.props = p;
    this.comp.__dc = this;
    this.host = host;
    this.after = [];
    this.pending = false;
    this.children = [];
    var self = this;
    this.schedule = function () {
      if (self.pending) return;
      self.pending = true;
      Promise.resolve().then(function () { self.pending = false; self.update(); });
    };
    this.listen();
    this.mount();
  }

  Instance.prototype.renderTree = function () {
    var vals = this.comp.renderVals() || {};
    var frag = document.createDocumentFragment();
    this.newImports = [];
    this.renderChildren(this.tpl, frag, vals);
    return frag;
  };

  Instance.prototype.renderChildren = function (src, out, scope) {
    for (var n = src.firstChild; n; n = n.nextSibling) this.renderNode(n, out, scope);
  };

  Instance.prototype.renderNode = function (n, out, scope) {
    if (n.nodeType === 3) {
      out.appendChild(document.createTextNode(n.data.indexOf("{{") < 0 ? n.data : interp(n.data, scope)));
      return;
    }
    if (n.nodeType !== 1) return;
    var tag = n.localName;
    if (tag === "helmet" || tag === "script") return;
    if (tag === "sc-if") {
      var c = n.getAttribute("value") || "";
      var m = c.match(ONE_HOLE);
      if (m ? lookup(m[1], scope) : c) this.renderChildren(n, out, scope);
      return;
    }
    if (tag === "sc-for") {
      var lm = (n.getAttribute("list") || "").match(ONE_HOLE);
      var list = lm ? lookup(lm[1], scope) : null;
      var as = n.getAttribute("as") || "item";
      if (list && list.length) {
        for (var i = 0; i < list.length; i++) {
          var sc = Object.create(scope);
          sc[as] = list[i];
          this.renderChildren(n, out, sc);
        }
      }
      return;
    }
    if (tag === "dc-import") {
      var props = {};
      for (var a = 0; a < n.attributes.length; a++) {
        var at = n.attributes[a];
        if (at.name === "name" || at.name.indexOf("hint-") === 0) continue;
        props[at.name] = interp(at.value, scope);
      }
      var slot = document.createElement("div");
      slot.setAttribute("data-dc-host", n.getAttribute("name"));
      slot.style.cssText = "width: 100%; height: 100%";
      slot.__dcImport = { name: n.getAttribute("name"), props: props };
      out.appendChild(slot);
      return;
    }
    var el = n.cloneNode(false);
    var handlers = null;
    for (var k = el.attributes.length - 1; k >= 0; k--) {
      var attr = el.attributes[k];
      var name = attr.name, raw = attr.value;
      if (name.indexOf("hint-") === 0) { el.removeAttribute(name); continue; }
      if (name.length > 2 && name.slice(0, 2) === "on") {
        el.removeAttribute(name);
        var hm = raw.match(ONE_HOLE);
        var fn = hm ? lookup(hm[1], scope) : null;
        if (typeof fn === "function") {
          var ev = name.slice(2);
          if (ev === "change") {
            var t = (n.getAttribute("type") || "").toLowerCase();
            ev = (tag === "select" || t === "checkbox" || t === "radio" || t === "file") ? "change" : "input";
          }
          handlers = handlers || {};
          handlers[ev] = fn;
        }
        continue;
      }
      if (raw.indexOf("{{") < 0) continue;
      var one = raw.match(ONE_HOLE);
      var v = one ? lookup(one[1], scope) : interp(raw, scope);
      if (one && typeof v === "boolean") {
        if (BOOL_ATTRS[name]) { if (v) el.setAttribute(name, ""); else el.removeAttribute(name); }
        else el.setAttribute(name, v ? "true" : "false");
      } else if (one && v == null) {
        el.removeAttribute(name);
      } else {
        el.setAttribute(name, str(v));
      }
      if (name === "value" && (tag === "textarea")) el.removeAttribute("value");
    }
    if (handlers) el.__dc = { id: this.id, h: handlers };
    if (tag === "textarea") {
      var vh = (n.getAttribute("value") || "").match(ONE_HOLE);
      if (vh) { var tv = str(lookup(vh[1], scope)); el.textContent = tv; el.value = tv; }
      else this.renderChildren(n, el, scope);
      return out.appendChild(el);
    }
    if (tag === "input") {
      if (el.hasAttribute("value")) el.value = el.getAttribute("value");
      el.checked = el.hasAttribute("checked");
    }
    this.renderChildren(n, el, scope);
    out.appendChild(el);
  };

  Instance.prototype.mountImports = function (root) {
    var self = this;
    var slots = root.querySelectorAll ? root.querySelectorAll("[data-dc-host]") : [];
    Array.prototype.forEach.call(slots, function (slot) {
      if (slot.__dcChild || !slot.__dcImport) return;
      slot.__dcChild = new Instance(slot.__dcImport.name, slot.__dcImport.props, slot);
      self.children.push(slot.__dcChild);
    });
  };

  Instance.prototype.mount = function () {
    var frag = this.renderTree();
    this.host.textContent = "";
    this.host.appendChild(frag);
    this.mountImports(this.host);
    if (this.comp.componentDidMount) this.comp.componentDidMount();
    this.flushAfter();
  };

  Instance.prototype.update = function () {
    var prevState = this.comp.__prevState;
    var frag = this.renderTree();
    var next = document.createElement(this.host.localName);
    next.appendChild(frag);
    var self = this;
    morphdom(this.host, next, {
      childrenOnly: true,
      onBeforeElUpdated: function (from, to) {
        if (from.hasAttribute && from.hasAttribute("data-dc-host") && from.__dcChild) return false;
        if (to.__dc) from.__dc = to.__dc; else if (from.__dc && from.__dc.id === self.id) delete from.__dc;
        if (to.__dcImport) from.__dcImport = to.__dcImport;
        return true;
      },
      onBeforeNodeDiscarded: function (node) {
        if (node.__dcChild && node.__dcChild.comp.componentWillUnmount) node.__dcChild.comp.componentWillUnmount();
        return true;
      }
    });
    this.mountImports(this.host);
    if (this.comp.componentDidUpdate) this.comp.componentDidUpdate(this.comp.props, prevState);
    this.flushAfter();
  };

  Instance.prototype.flushAfter = function () {
    var a = this.after; this.after = [];
    a.forEach(function (f) { try { f(); } catch (e) { console.error(e); } });
  };

  Instance.prototype.listen = function () {
    var self = this, host = this.host;
    function wrap(ev, el) {
      var stopped = false;
      return {
        type: ev.type, target: ev.target, currentTarget: el, nativeEvent: ev,
        key: ev.key, clientX: ev.clientX, clientY: ev.clientY, button: ev.button,
        preventDefault: function () { ev.preventDefault(); },
        stopPropagation: function () { stopped = true; ev.stopPropagation(); },
        isStopped: function () { return stopped; }
      };
    }
    function bubble(ev) {
      var el = ev.target;
      while (el && el !== host.parentNode) {
        var d = el.__dc;
        if (d && d.id === self.id && d.h[ev.type]) {
          var w = wrap(ev, el);
          d.h[ev.type].call(el, w);
          if (w.isStopped()) break;
        }
        if (el === host) break;
        el = el.parentNode;
      }
    }
    ["click", "input", "change", "pointerdown", "keydown", "submit"].forEach(function (t) {
      host.addEventListener(t, bubble);
    });
    host.addEventListener("keydown", function (ev) {
      var el = ev.target;
      if (!ev.defaultPrevented && (ev.key === "Enter" || ev.key === " ") && el && el.getAttribute && el.getAttribute("role") === "button" && el.localName !== "button") {
        ev.preventDefault();
        el.click();
      }
    });
    host.addEventListener("scroll", function (ev) {
      var el = ev.target, d = el && el.__dc;
      if (d && d.id === self.id && d.h.scroll) d.h.scroll.call(el, wrap(ev, el));
    }, true);
  };

  function boot(name, hostId) {
    var host = document.getElementById(hostId);
    return new Instance(name, {}, host);
  }

  window.DC = { define: function (name, factory, defaults) { defs[name] = { factory: factory, defaults: defaults || {} }; }, boot: boot, DCLogic: DCLogic };
})();
