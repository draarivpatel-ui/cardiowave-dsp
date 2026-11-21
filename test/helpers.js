/* Minimal deterministic DOM and canvas stub for Node UI smoke tests. */
'use strict';

function makeClassList() {
  var set = {};
  return {
    add: function (c) { set[c] = true; },
    remove: function (c) { delete set[c]; },
    contains: function (c) { return !!set[c]; }
  };
}

function makeElement(tag, id, doc) {
  var el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    nodeName: String(tag || 'div').toUpperCase(),
    value: '',
    _text: '',
    className: '',
    disabled: false,
    selectedOptions: [],
    children: [],
    attributes: {},
    parentNode: null,
    style: {},
    classList: makeClassList(),
    listeners: {},
    clientWidth: 700,
    width: 0,
    height: 0,
    appendChild: function (child) { child.parentNode = el; el.children.push(child); return child; },
    removeChild: function (child) {
      var i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      return child;
    },
    remove: function () { if (el.parentNode) el.parentNode.removeChild(el); },
    setAttribute: function (k, v) { el.attributes[k] = String(v); },
    getAttribute: function (k) { return el.attributes[k] === undefined ? null : el.attributes[k]; },
    removeAttribute: function (k) { delete el.attributes[k]; },
    addEventListener: function (type, fn) { (el.listeners[type] = el.listeners[type] || []).push(fn); },
    removeEventListener: function () {},
    dispatch: function (type, event) {
      var list = el.listeners[type] || [];
      for (var i = 0; i < list.length; i++) list[i](event || { type: type, target: el, preventDefault: function () {} });
      return list.length;
    },
    focus: function () { doc.activeElement = el; },
    click: function () { return el.dispatch('click'); },
    querySelectorAll: function () { return []; },
    getContext: function () { return el._ctx || (el._ctx = makeContext()); }
  };
  // Mirror the real DOM: assigning textContent or innerHTML replaces all
  // child nodes. The app uses this to clear tables before repopulating them.
  Object.defineProperty(el, 'textContent', {
    get: function () { return el._text; },
    set: function (v) { el._text = String(v); el.children = []; },
    enumerable: true
  });
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return el._html || ''; },
    set: function (v) { el._html = String(v); el.children = []; },
    enumerable: true
  });
  return el;
}

function makeContext() {
  var noop = function () {};
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left',
    calls: { stroke: 0, fill: 0, fillText: 0, fillRect: 0, clearRect: 0, arc: 0, lineTo: 0 },
    setTransform: noop, clearRect: function () { this.calls.clearRect++; },
    fillRect: function () { this.calls.fillRect++; }, strokeRect: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: function () { this.calls.lineTo++; },
    stroke: function () { this.calls.stroke++; }, fill: function () { this.calls.fill++; },
    arc: function () { this.calls.arc++; }, setLineDash: noop, save: noop, restore: noop,
    fillText: function () { this.calls.fillText++; }, measureText: function () { return { width: 10 }; },
    createLinearGradient: function () { return { addColorStop: noop }; },
    translate: noop, scale: noop, rotate: noop
  };
}

/*
 * Builds a DOM with the exact ids that app.js looks up. The ids and tab list
 * are derived from the real index.html at test time by parseHtmlIds().
 */
function createDom(ids, tabIds) {
  var doc = {
    readyState: 'complete',
    activeElement: null,
    body: null,
    elements: {},
    listeners: {},
    addEventListener: function (type, fn) { (doc.listeners[type] = doc.listeners[type] || []).push(fn); },
    removeEventListener: function () {},
    createElement: function (tag) { return makeElement(tag, '', doc); },
    getElementById: function (id) { return doc.elements[id] || null; },
    querySelectorAll: function (selector) {
      if (selector === '[role="tab"]') {
        return (tabIds || []).map(function (id) { return doc.getElementById('tab-' + id); }).filter(Boolean);
      }
      return [];
    },
    dispatch: function (type, event) {
      var list = doc.listeners[type] || [];
      for (var i = 0; i < list.length; i++) list[i](event || { type: type, target: doc.body, preventDefault: function () {} });
      return list.length;
    }
  };
  doc.body = makeElement('body', 'body', doc);
  (ids || []).forEach(function (id) {
    var tag = /^(ecg-canvas|leads-canvas|bode-canvas|stages-canvas|tacho-canvas|poincare-canvas|psd-canvas|score-canvas|sweep-canvas)$/.test(id)
      ? 'canvas' : (/^(run|reset|run-eval|run-suite|build-export|download-header|download-signals|download-ann)$/.test(id) ? 'button' : 'div');
    var el = makeElement(tag, id, doc);
    if (/^tab-/.test(id)) el.tagName = 'BUTTON';
    doc.elements[id] = el;
  });
  // Wire canvas parent nodes so setupCanvas can measure clientWidth.
  Object.keys(doc.elements).forEach(function (id) {
    var el = doc.elements[id];
    if (el.tagName === 'CANVAS') {
      var wrap = makeElement('div', '', doc);
      wrap.clientWidth = 700;
      wrap.appendChild(el);
    }
  });
  return doc;
}

/* Extract every id="..." and role="tabpanel" id from a real HTML string. */
function parseHtmlIds(html) {
  var ids = [];
  var re = /\bid="([^"]+)"/g;
  var m;
  while ((m = re.exec(html)) !== null) if (ids.indexOf(m[1]) < 0) ids.push(m[1]);
  return ids;
}

function parseTabIds(html) {
  var out = [];
  var re = /id="tab-([a-z-]+)"/g;
  var m;
  while ((m = re.exec(html)) !== null) if (out.indexOf(m[1]) < 0) out.push(m[1]);
  return out;
}

module.exports = {
  createDom: createDom,
  makeElement: makeElement,
  makeContext: makeContext,
  parseHtmlIds: parseHtmlIds,
  parseTabIds: parseTabIds
};
