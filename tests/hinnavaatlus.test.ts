import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasKeyword, prefilter } from '../src/prefilter.ts';
import { decodeEntities, feedUrl, firstPicture, mergeForumPages, parseFeed, parseForumPage, parseReferencePrices, parseTopicPage, TOPIC_TEXT_MAX } from '../src/sources/hinnavaatlus.ts';
import { DDR5_WATCH, fixture } from './helpers.ts';

const items = () => mergeForumPages(parseFeed(fixture('hinnavaatlus/feed.xml')), [parseForumPage(fixture('hinnavaatlus/forum-3.html'))]);
const byId = (id: string) => {
  const i = items().find((x) => x.id === id);
  assert.ok(i, id);
  return i;
};

test('the feed parses into items, oldest first, decoded right', () => {
  const list = parseFeed(fixture('hinnavaatlus/feed.xml'));
  assert.deepEqual(
    list.map((i) => i.id),
    ['875848', '875884', '875924', '874642', '875412'],
  );
  const laptop = list.find((i) => i.id === '875884');
  assert.equal(laptop?.forum, 59);
  assert.match(laptop?.text ?? '', /kompaktne sülearvuti mängimiseks/);
  assert.equal(laptop?.url, 'https://foorum.hinnavaatlus.ee/viewtopic.php?t=875884');
  // The feed cuts the title; its "..." is dropped.
  assert.equal(laptop?.title, 'Dell Alienware 15 DA15260 (Core 7 240H / 32 GB / 1');
  // Cut right after the title: no trailing " ::".
  assert.equal(list.find((i) => i.id === '875924')?.title, 'Lauaarvuti - 14600KF / 32GB DDR4 / RX 9070');
  assert.equal(list.find((i) => i.id === '875412')?.picture, 'https://www.upload.ee/thumb/19892700/20261026_165637.jpg');
});

test('the list page gives full titles and drops stickies', () => {
  const page = parseForumPage(fixture('hinnavaatlus/forum-3.html'));
  assert.deepEqual([...page.stickies], ['561069']);
  assert.equal(page.titles.get('875412'), 'M: Kasutusvalmis mängur Intel i5, B760M, 32GB DDR5, 2TB NVME, ARC B580, 850W PSU ja 3x MiniPC');
  const sticky = { ...byId('874642'), id: '561069', key: 'hv:561069' };
  assert.deepEqual(mergeForumPages([sticky], [page]), []);
  assert.equal(byId('875924').title, 'M: Lauaarvuti - 14600KF / 32GB DDR4 / RX 9070');
});

test('entities, pictures and URLs', () => {
  assert.equal(decodeEntities('DDR4 4x16GB &amp;amp; 2x8'.replace('&amp;amp;', '&amp;')), 'DDR4 4x16GB & 2x8');
  assert.equal(decodeEntities('&#252;&#x00f5;&nbsp;'), 'üõ ');
  assert.equal(firstPicture('<img src="https://foorum.hinnavaatlus.ee/images/smiles/x.gif"><img src="javascript:alert(1)"><img src="https://seller.example/a.jpg"><img src="https://www.upload.ee/thumb/1/a.jpg">'), 'https://www.upload.ee/thumb/1/a.jpg');
  assert.equal(firstPicture('<img src="https://upload.ee.seller.example/a.jpg">'), undefined);
  assert.equal(firstPicture('<img src="ftp://x/a.jpg">'), undefined);
  assert.equal(feedUrl([59, 3, 3]), 'https://foorum.hinnavaatlus.ee/smartfeed.php?feed_type=RSS2.0&limit=1%20DAY&sort_by=postdate_desc&topicsonly=1&firstpostonly=1&forum=3&forum=59&max_word_size=All');
});

test('reference prices from the price search', () => {
  const prices = parseReferencePrices(fixture('hinnavaatlus/search.html'));
  assert.equal(prices.length, 3);
  assert.deepEqual(prices[0], { name: 'Mälu G.Skill DDR5 Flare X5 32GB (2x16GB) 6000 CL30', eur: 691.07 });
});

test('a topic page gives its posts as text, the seller marked and usernames left out', () => {
  const text = parseTopicPage(fixture('hinnavaatlus/topic.html'));
  const posts = text.split('\n\n[');
  assert.equal(posts.length, 4);
  assert.match(text, /^\[15\.11\.2026 20:18, seller\]\nMüüa heas korras/);
  assert.match(text, /RTX 4070 Super MSI Ventus 2x OC AH 700\/ OK 750/);
  assert.match(posts[1] ?? '', /^15\.11\.2026 20:46, someone else\]\n2\) 16GB ddr5/);
  assert.match(posts[3] ?? '', /^17\.11\.2026 20:15, seller\]\n1\) ja 2\) müüdud$/);
  assert.doesNotMatch(text, /myyja_test|ostja_yks|ostja_kaks|<|thumbs_up/);
  const long = `<span class="name"><a name="1"></a><b><a class="name">x</a></b></span><td colspan="2"><span class="postbody">${'a '.repeat(6000)}</span><span class="postbody"></span>`;
  assert.equal(parseTopicPage(long).length, TOPIC_TEXT_MAX);
});

test('keywords match at the start of a word', () => {
  assert.ok(hasKeyword('msi pro z790-a wifi ddr5.', 'ddr5'));
  assert.ok(hasKeyword('intel core i5-14500', '14500'));
  assert.ok(hasKeyword('m: ram', 'm:'));
  assert.ok(!hasKeyword('gtx 1650 4gb gddr5', 'ddr5'));
  assert.ok(!hasKeyword('hind 214600', '14600'));
});

test('the first watch keeps both DDR5 listings and drops the DDR4 PC and the laptop', () => {
  const run = (id: string) => {
    const i = byId(id);
    return prefilter(DDR5_WATCH, i.title, i.text);
  };
  assert.equal(run('874642').pass, false); // RAM only
  assert.equal(run('875412').pass, false); // whole PC
  assert.deepEqual(run('875924'), { pass: true, code: 'excluded', keyword: 'ddr4 unless ddr5' });
  assert.deepEqual(run('875884'), { pass: true, code: 'excluded', keyword: 'sülearvuti' });
  assert.deepEqual(run('875848'), { pass: true, code: 'excluded', keyword: 'sülearvuti' });
  assert.deepEqual(prefilter(DDR5_WATCH, 'O: ostan DDR5 mälu', ''), { pass: true, code: 'excluded', keyword: 'ostan' });
  assert.deepEqual(prefilter(DDR5_WATCH, 'M: RTX 3060', 'Videokaart'), { pass: true, code: 'no_keyword', keyword: '' });
});
