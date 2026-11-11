import test from 'node:test';
import assert from 'node:assert/strict';
import { h, Fragment, raw } from '../src/web/jsx.js';

test('JSX runtime escapes text and attributes but keeps trusted markup', () => {
  const html = h('p', { title: '"><script>' }, '<b>&</b>', raw('<em>ok</em>'), 3, null, false, ['a', ['b']]).value;
  assert.equal(html, '<p title="&quot;&gt;&lt;script&gt;">&lt;b&gt;&amp;&lt;/b&gt;<em>ok</em>3ab</p>');
});

test('JSX runtime renders void elements, boolean attributes and components', () => {
  const Item = ({ label }: { label: string }) => h('li', null, label);
  assert.equal(h('input', { required: true, disabled: false, hidden: undefined, value: 'x' }).value, '<input required value="x">');
  assert.equal(h(Fragment, null, h(Item, { label: 'uno' }), h(Item, { label: 'dos' })).value, '<li>uno</li><li>dos</li>');
});

test('JSX runtime refuses markup the content security policy would block or that could inject', () => {
  assert.throws(() => h('button', { onclick: 'alert(1)' }), /onclick/);
  assert.throws(() => h('div', { style: 'color:red' }), /style/);
  assert.throws(() => h('div', { 'x"y': '1' }), /attribute name/);
  assert.throws(() => h('scr ipt', null), /element name/);
});
