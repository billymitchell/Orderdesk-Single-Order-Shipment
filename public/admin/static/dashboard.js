// Order Desk shipment log dashboard. Every value from a log is rendered with
// textContent: inbound payloads are untrusted input.
(function () {
  'use strict';

  var OUTCOME_LABELS = {
    success: 'Success',
    partial_failure: 'Partly rejected',
    validation_error: 'Validation error',
    unauthorized: 'Unauthorized',
    not_found: 'Not found',
    conflict: 'Conflict',
    error: 'Server error',
    downstream_error: 'Order Desk error',
    network_error: 'Network / timeout'
  };
  var FILTER_KEYS = ['from', 'to', 'direction', 'outcome', 'status', 'method', 'store', 'auth', 'batch', 'q'];
  var storeNames = {};

  var state = {
    from: '', to: '', direction: '', outcome: '', status: '', method: '', store: '', auth: '', batch: '', q: '',
    sort: 'created_at', dir: 'desc', page: 1, pageSize: 50, id: ''
  };
  var requestSeq = 0;
  var currentDetail = null;
  var currentTab = 'request';

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'text') node.textContent = attrs[key];
        else if (key === 'className') node.className = attrs[key];
        else node.setAttribute(key, attrs[key]);
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function localDate(offsetDays) {
    var date = new Date();
    date.setDate(date.getDate() + (offsetDays || 0));
    var month = String(date.getMonth() + 1).padStart(2, '0');
    var day = String(date.getDate()).padStart(2, '0');
    return date.getFullYear() + '-' + month + '-' + day;
  }

  // Date inputs are local calendar days; the API gets exact instants.
  function startOfDay(value) { return value ? new Date(value + 'T00:00:00').toISOString() : ''; }
  function endOfDay(value) { return value ? new Date(value + 'T23:59:59.999').toISOString() : ''; }

  function formatTime(iso) {
    var date = new Date(iso);
    return date.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit'
    });
  }

  function readUrl() {
    var params = new URLSearchParams(location.search);
    var fresh = !location.search;
    FILTER_KEYS.forEach(function (key) { state[key] = params.get(key) || ''; });
    if (fresh) state.from = localDate(-6);
    state.sort = params.get('sort') || 'created_at';
    state.dir = params.get('dir') === 'asc' ? 'asc' : 'desc';
    state.page = Math.max(parseInt(params.get('page'), 10) || 1, 1);
    state.pageSize = parseInt(params.get('pageSize'), 10) || 50;
    state.id = params.get('id') || '';
  }

  function writeUrl() {
    var params = new URLSearchParams();
    FILTER_KEYS.forEach(function (key) { if (state[key]) params.set(key, state[key]); });
    if (!state.from) params.set('from', '');
    if (state.sort !== 'created_at') params.set('sort', state.sort);
    if (state.dir !== 'desc') params.set('dir', state.dir);
    if (state.page > 1) params.set('page', String(state.page));
    if (state.pageSize !== 50) params.set('pageSize', String(state.pageSize));
    if (state.id) params.set('id', state.id);
    history.replaceState(null, '', '/admin' + (params.toString() ? '?' + params : ''));
  }

  function apiParams(extra) {
    var params = new URLSearchParams();
    if (state.from) params.set('from', startOfDay(state.from));
    if (state.to) params.set('to', endOfDay(state.to));
    ['direction', 'outcome', 'status', 'method', 'store', 'auth', 'batch', 'q', 'sort', 'dir'].forEach(function (key) {
      if (state[key]) params.set(key, state[key]);
    });
    Object.keys(extra || {}).forEach(function (key) { params.set(key, extra[key]); });
    return params;
  }

  function api(path) {
    return fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (response) {
        if (response.status === 401) {
          location.href = '/admin/login';
          throw new Error('Signed out');
        }
        if (!response.ok) throw new Error('Request failed (' + response.status + ')');
        return response.json();
      });
  }

  function syncForm() {
    var form = $('filters');
    FILTER_KEYS.forEach(function (key) { form.elements[key].value = state[key]; });
    $('pageSize').value = String(state.pageSize);
    Array.prototype.forEach.call(document.querySelectorAll('th[data-sort]'), function (th) {
      var active = th.getAttribute('data-sort') === state.sort;
      if (active) th.setAttribute('aria-sort', state.dir === 'asc' ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    });
    $('export').href = '/admin/api/logs/export.csv?' + apiParams({}).toString();
  }

  function badge(outcome) {
    return el('span', { className: 'badge badge-' + outcome, text: OUTCOME_LABELS[outcome] || outcome });
  }

  function directionTag(direction) {
    return el('span', {
      className: 'dir dir-' + direction,
      text: direction === 'inbound' ? 'IN' : 'OUT',
      title: direction === 'inbound' ? 'Caller → this API' : 'This API → Order Desk'
    });
  }

  function shortUrl(row) {
    var url = row.url || '';
    if (row.direction === 'outbound') url = url.replace(/^https:\/\/app\.orderdesk\.me\/api\/v2/, '');
    return row.method + ' ' + url;
  }

  function storeLabel(ids) {
    return (ids || []).map(function (id) { return storeNames[id] ? id + ' ' + storeNames[id] : id; }).join('\n');
  }

  function renderChips(counts) {
    var nav = $('chips');
    clear(nav);
    var total = Object.keys(counts).reduce(function (sum, key) { return sum + counts[key]; }, 0);
    var items = [['', 'All', total]].concat(Object.keys(OUTCOME_LABELS).map(function (key) {
      return [key, OUTCOME_LABELS[key], counts[key] || 0];
    }));
    items.forEach(function (item) {
      if (item[0] && !item[2] && state.outcome !== item[0]) return;
      var chip = el('button', { type: 'button', className: 'chip', 'aria-pressed': String(state.outcome === item[0]) }, [
        item[1], el('span', { className: 'count', text: String(item[2]) })
      ]);
      chip.addEventListener('click', function () {
        state.outcome = item[0];
        state.page = 1;
        load();
      });
      nav.appendChild(chip);
    });
  }

  function renderTable(result) {
    var tbody = document.querySelector('#logs tbody');
    clear(tbody);
    result.rows.forEach(function (row) {
      var tr = el('tr', { 'data-id': row.id, tabindex: '0' }, [
        el('td', { text: formatTime(row.created_at), title: row.created_at }),
        el('td', null, [directionTag(row.direction)]),
        el('td', null, [badge(row.outcome)]),
        el('td', { className: 'req', text: shortUrl(row), title: row.method + ' ' + row.url }),
        el('td', { className: 'status', text: row.status === null ? '—' : String(row.status) }),
        el('td', { className: 'num', text: row.shipment_count === null ? '—' : String(row.shipment_count) }),
        el('td', { className: 'ids', text: (row.tracking_numbers || []).join('\n') || '—' }),
        el('td', { className: 'ids', text: (row.order_numbers || []).join('\n') || '—' }),
        el('td', { className: 'ids', text: storeLabel(row.store_ids) || '—' }),
        el('td', { className: 'num', text: row.duration_ms === null ? '—' : String(row.duration_ms) })
      ]);
      if (row.id === state.id) tr.className = 'selected';
      tr.addEventListener('click', function () { openDetail(row.id); });
      tr.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') openDetail(row.id);
      });
      tbody.appendChild(tr);
    });
    $('empty').hidden = result.rows.length > 0;

    var start = result.total ? (result.page - 1) * result.pageSize + 1 : 0;
    var end = Math.min(result.page * result.pageSize, result.total);
    $('range').textContent = start + '–' + end + ' of ' + result.total.toLocaleString();
    $('prev').disabled = result.page <= 1;
    $('next').disabled = end >= result.total;
  }

  function load() {
    var seq = ++requestSeq;
    writeUrl();
    syncForm();
    $('error').hidden = true;
    var params = apiParams({ page: state.page, pageSize: state.pageSize });
    return api('/admin/api/logs?' + params.toString())
      .then(function (result) {
        if (seq !== requestSeq) return;

        renderChips(result.counts || {});
        renderTable(result);
      })
      .catch(function (error) {
        if (seq !== requestSeq || error.message === 'Signed out') return;
        $('error').textContent = 'Could not load logs. ' + error.message;
        $('error').hidden = false;
      });
  }

  // ----- Detail drawer -----

  function metaRow(list, label, value) {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return;
    list.appendChild(el('dt', { text: label }));
    list.appendChild(el('dd', { text: Array.isArray(value) ? value.join(', ') : String(value) }));
  }

  function jsonBlock(title, value) {
    var text = value === null || value === undefined ? '(none)' : JSON.stringify(value, null, 2);
    var copy = el('button', { type: 'button', className: 'secondary', text: 'Copy' });
    copy.addEventListener('click', function () {
      navigator.clipboard.writeText(text).then(function () {
        copy.textContent = 'Copied';
        setTimeout(function () { copy.textContent = 'Copy'; }, 1500);
      });
    });
    return el('section', { className: 'block' }, [
      el('div', { className: 'block-head' }, [el('h3', { text: title }), copy]),
      el('pre', { text: text })
    ]);
  }

  function filterByBatch(batchId) {
    FILTER_KEYS.forEach(function (key) { if (key !== 'from' && key !== 'to') state[key] = ''; });
    state.batch = batchId;
    state.from = '';
    state.page = 1;
    closeDetail();
    load();
  }

  function renderRelated(panel, row) {
    var related = row.related || [];
    if (!(row.batch_ids || []).length) {
      panel.appendChild(el('p', { className: 'muted', text: 'This request is not linked to a batch.' }));
      return;
    }
    panel.appendChild(el('p', { className: 'muted small', text: row.direction === 'inbound'
      ? 'Order Desk calls the worker made for this batch, and other calls about it.'
      : 'The submission that created this batch, and other Order Desk calls for it.' }));
    if (!related.length) {
      panel.appendChild(el('p', { className: 'muted', text: 'No other logged requests for this batch yet.' }));
    } else {
      var list = el('ul', { className: 'related' });
      related.forEach(function (item) {
        var button = el('button', { type: 'button', className: 'secondary' }, [
          directionTag(item.direction), badge(item.outcome),
          el('span', { className: 'req', text: shortUrl(item) }),
          el('span', { className: 'muted', text: (item.status || '—') + ' · ' + formatTime(item.created_at) })
        ]);
        button.addEventListener('click', function () { openDetail(item.id); });
        list.appendChild(el('li', null, [button]));
      });
      panel.appendChild(list);
    }
    row.batch_ids.forEach(function (batchId) {
      var show = el('button', { type: 'button', className: 'link-button', text: 'Show every request for batch ' + batchId });
      show.addEventListener('click', function () { filterByBatch(batchId); });
      panel.appendChild(el('p', null, [show]));
    });
  }

  function renderTab() {
    var panel = $('drawer-panel');
    clear(panel);
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (button) {
      button.setAttribute('aria-selected', String(button.getAttribute('data-tab') === currentTab));
    });
    var row = currentDetail;
    if (!row) return;
    var inbound = row.direction === 'inbound';
    if (currentTab === 'request') {
      panel.appendChild(el('p', { className: 'muted small', text: row.method + ' ' + row.url }));
      panel.appendChild(jsonBlock(inbound ? 'Body from caller' : 'Body sent to Order Desk', row.request_body));
      panel.appendChild(jsonBlock(inbound ? 'Headers (allowlisted)' : 'Headers (API key redacted)', row.request_headers));
    } else if (currentTab === 'response') {
      if (row.status === null) {
        panel.appendChild(el('p', { className: 'muted', text: inbound
          ? 'No response was recorded.'
          : 'Order Desk did not respond: ' + (row.error_message || 'network error') }));
      } else {
        panel.appendChild(jsonBlock((inbound ? 'Our response (' : 'Order Desk response (') + row.status + ')', row.response_body));
      }
    } else {
      renderRelated(panel, row);
    }
  }

  function openDetail(id) {
    state.id = id;
    writeUrl();
    Array.prototype.forEach.call(document.querySelectorAll('#logs tbody tr'), function (tr) {
      tr.className = tr.getAttribute('data-id') === id ? 'selected' : '';
    });
    $('drawer').hidden = false;
    $('scrim').hidden = false;
    $('drawer-title').textContent = 'Loading…';
    $('drawer-sub').textContent = '';
    clear($('drawer-meta'));
    clear($('drawer-panel'));
    api('/admin/api/logs/' + encodeURIComponent(id))
      .then(function (row) {
        if (state.id !== id) return;
        currentDetail = row;
        var title = $('drawer-title');
        clear(title);
        title.appendChild(document.createTextNode(formatTime(row.created_at) + ' '));
        title.appendChild(badge(row.outcome));
        $('drawer-sub').textContent = row.error_message || '';
        var meta = $('drawer-meta');
        metaRow(meta, 'Log ID', row.id);
        metaRow(meta, 'Direction', row.direction === 'inbound' ? 'Inbound (caller → this API)' : 'Outbound (this API → Order Desk)');
        metaRow(meta, 'Request', row.method + ' ' + row.url);
        metaRow(meta, 'Time', row.created_at);
        metaRow(meta, 'Status', row.status);
        metaRow(meta, 'Duration', row.duration_ms === null ? null : row.duration_ms + ' ms');
        metaRow(meta, 'Inbound key', row.inbound_auth);
        metaRow(meta, 'Idempotency key', row.idempotency_key);
        metaRow(meta, 'Error code', row.error_code);
        metaRow(meta, 'Tokens remaining', row.tokens_remaining);
        metaRow(meta, 'Store', storeLabel(row.store_ids).replace(/\n/g, ', '));
        metaRow(meta, 'Batch ID', row.batch_ids);
        metaRow(meta, 'Job ID', row.job_ids);
        metaRow(meta, 'Tracking #', row.tracking_numbers);
        metaRow(meta, 'Order #', row.order_numbers);
        renderTab();
      })
      .catch(function (error) {
        if (error.message === 'Signed out') return;
        $('drawer-title').textContent = 'Could not load this request';
        $('drawer-sub').textContent = error.message;
      });
  }

  function closeDetail() {
    state.id = '';
    currentDetail = null;
    $('drawer').hidden = true;
    $('scrim').hidden = true;
    writeUrl();
    Array.prototype.forEach.call(document.querySelectorAll('#logs tbody tr.selected'), function (tr) {
      tr.className = '';
    });
  }

  // ----- Wiring -----

  var searchTimer = null;
  function onFilterChange(event) {
    var form = $('filters');
    FILTER_KEYS.forEach(function (key) { state[key] = form.elements[key].value.trim(); });
    state.page = 1;
    clearTimeout(searchTimer);
    if (event && event.target && (event.target.name === 'q' || event.target.name === 'batch')) {
      searchTimer = setTimeout(load, 300);
    } else {
      load();
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    readUrl();

    var form = $('filters');
    form.addEventListener('change', onFilterChange);
    form.elements.q.addEventListener('input', onFilterChange);
    form.elements.batch.addEventListener('input', onFilterChange);
    form.addEventListener('submit', function (event) { event.preventDefault(); onFilterChange(); });

    $('reset').addEventListener('click', function () {
      FILTER_KEYS.forEach(function (key) { state[key] = ''; });
      state.from = localDate(-6);
      state.page = 1;
      load();
    });

    Array.prototype.forEach.call(document.querySelectorAll('th[data-sort] button'), function (button) {
      button.addEventListener('click', function () {
        var key = button.parentNode.getAttribute('data-sort');
        if (state.sort === key) {
          state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sort = key;
          state.dir = key === 'created_at' || key === 'duration_ms' || key === 'shipment_count' ? 'desc' : 'asc';
        }
        state.page = 1;
        load();
      });
    });

    $('prev').addEventListener('click', function () { state.page = Math.max(1, state.page - 1); load(); });
    $('next').addEventListener('click', function () { state.page += 1; load(); });
    $('pageSize').addEventListener('change', function () {
      state.pageSize = parseInt($('pageSize').value, 10) || 50;
      state.page = 1;
      load();
    });

    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (button) {
      button.addEventListener('click', function () {
        currentTab = button.getAttribute('data-tab');
        renderTab();
      });
    });
    $('drawer-close').addEventListener('click', closeDetail);
    $('scrim').addEventListener('click', closeDetail);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !$('drawer').hidden) closeDetail();
    });

    api('/admin/api/me').then(function (me) {
      $('me').textContent = me.email;
      var select = $('filters').elements.store;
      (me.stores || []).forEach(function (store) {
        storeNames[store.id] = store.name;
        select.appendChild(el('option', { value: store.id, text: store.id + ' · ' + store.name }));
      });
      select.value = state.store;
      $('retention').textContent = 'Requests are kept for ' + me.retention_days + ' days.';
    }).catch(function () {});

    load().then(function () {
      if (state.id) openDetail(state.id);
    });
  });
})();
