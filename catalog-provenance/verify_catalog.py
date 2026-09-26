"""Read public Apple HK catalog and announcement pages; never query stock or mutate a bag.

Run without arguments to compare all products without changing any files. Pass
--write-catalog to update the bundled HK catalog and evidence after all checks pass.
No SKU, purchase URL, or price is synthesized.
"""
import argparse
import datetime
import gzip
import hashlib
import html
import itertools
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
CATALOG = ROOT.parent / 'extension/data/products/product_data_hk.json'
FAMILIES = {
    'iphone18pro': ('iPhone 18 Pro', 'iphone-18-pro', '6.3'),
    'iphone18promax': ('iPhone 18 Pro Max', 'iphone-18-pro', '6.9'),
    'iphoneduo': ('iPhone Duo', 'iphone-duo', '7.6'),
}
COLORS = {'布根地紅色': '布根地红色', '冰川色': '冰川色', '銀色': '银色',
          '黑色': '黑色', '星光白色': '星光白色', '夜空色': '夜空色'}
CAPACITIES = ['256GB', '512GB', '1TB', '2TB']
PREORDER_TEXT = '10 月 16 日晚上 8 時起接受預訂'
PREORDER_AT = '2026-10-16T20:00:00+08:00'
PREORDER_NEWS_URL = 'https://www.apple.com/hk/newsroom/2026/09/apple-unveils-iphone-duo/'
PRODUCT_FIELDS = ('Model', 'Capacity', 'Color', 'Code', 'Type', 'PurchasePath', 'Price', 'PreorderAt')


def object_after(document, marker):
    assert document.count(marker) == 1, 'Missing or ambiguous marker: ' + marker
    return json.JSONDecoder().raw_decode(document.split(marker, 1)[1].lstrip())[0]


def fetch_document(url):
    fetched = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with urllib.request.urlopen(url, timeout=30) as response:
        assert response.status == 200
        assert response.url == url, 'Unexpected redirect'
        raw = response.read()
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return raw.decode('utf-8'), {'source_url': url, 'final_url': url, 'fetched_at': fetched,
                               'http_status': 200,
                               'decompressed_html_sha256': hashlib.sha256(raw).hexdigest(),
                               'decompressed_html_size': len(raw)}


def verify_preorder():
    document, source = fetch_document(PREORDER_NEWS_URL)
    articles = []
    for block in re.findall(r'<script\b[^>]*\btype=[\"\x27]application/ld\+json[\"\x27][^>]*>(.*?)</script>',
                            document, re.IGNORECASE | re.DOTALL):
        data = json.loads(block)
        if isinstance(data, dict) and data.get('@type') == 'NewsArticle':
            articles.append(data)
    assert len(articles) == 1, 'Missing or ambiguous dated official announcement'
    article = articles[0]
    assert article.get('mainEntityOfPage') == PREORDER_NEWS_URL, 'Wrong announcement identity'
    assert article.get('datePublished') == '2026-09-09Z', 'Announcement publication date changed; re-review year'
    text = ' '.join(html.unescape(re.sub(r'<[^>]+>', ' ', document)).split())
    assert '2026 年 9 月 9 日' in text, 'Visible publication date differs from metadata'
    announcement = '香港時間 10 月 16 日 (星期五) 晚上 8 時起'
    assert announcement in text, 'Hong Kong preorder date or time changed; re-review date'
    preorder = datetime.datetime.fromisoformat(PREORDER_AT)
    assert preorder.year == int(article['datePublished'][:4])
    assert (preorder.month, preorder.day, preorder.hour, preorder.minute, preorder.second) == (10, 16, 20, 0, 0)
    assert preorder.weekday() == 4 and preorder.utcoffset() == datetime.timedelta(hours=8)
    return {**source, 'date_published': article['datePublished'],
            'announcement': announcement, 'normalized': PREORDER_AT,
            'interpretation': 'Year from the dated official launch announcement; the announcement explicitly specifies Hong Kong time.'}


def extract(slug):
    url = 'https://www.apple.com/hk-zh/shop/buy-iphone/' + slug
    document, metadata = fetch_document(url)
    fetched = metadata['fetched_at']
    selection = object_after(document, 'productSelectionData:')
    links = set(html.unescape(link) for link in re.findall(r'href="([^\"]+)"', document))
    if slug == 'iphone-duo':
        assert PREORDER_TEXT in document, 'Preorder announcement changed; re-review date'
    records = []
    for index, source in enumerate(selection['products']):
        family = source['familyType']
        assert family in FAMILIES
        model, expected_slug, screen = FAMILIES[family]
        assert expected_slug == slug
        code = source['partNumber']
        assert re.fullmatch(r'[A-Z0-9]+ZA/A', code), 'Unrecognized HK SKU format'
        capacity = source['dimensionCapacity'].upper()
        assert capacity in CAPACITIES
        official_color = selection['displayValues']['dimensionColor'][source['dimensionColor']]['value']
        color = COLORS[official_color]
        if family != 'iphoneduo':
            assert str(source['dimensionScreensize']) == screen.replace('.', '_') + 'inch'
        price = object_after(document, json.dumps(source['fullPrice']) + ':')
        assert price['product'] == price['partNumber']
        assert code in price['validProducts'], 'Price does not apply to this SKU'
        price_owner = next(row for row in selection['products'] if row['partNumber'] == price['product'])
        assert price_owner['familyType'] == family and price_owner['dimensionCapacity'] == source['dimensionCapacity']
        assert price['priceCurrency'] == 'HKD'
        amount = float(price['currentPrice']['raw_amount'])
        assert amount > 0 and amount.is_integer()
        assert amount == price['amountBeforeTradeIn']
        expected_path = '/hk-zh/shop/buy-iphone/{}/{}-吋顯示器-{}-{}'.format(
            slug, screen, source['dimensionCapacity'], official_color)
        matches = [link for link in links
                   if urllib.parse.urlsplit(link).scheme == 'https'
                   and urllib.parse.urlsplit(link).netloc == 'www.apple.com'
                   and not urllib.parse.urlsplit(link).query
                   and not urllib.parse.urlsplit(link).fragment
                   and urllib.parse.unquote(urllib.parse.urlsplit(link).path) == expected_path]
        assert len(matches) == 1, 'Missing or ambiguous official variant href'
        # Retain the actual href pathname; expected_path above is only a matching assertion.
        purchase_path = urllib.parse.urlsplit(matches[0]).path
        product = {'Model': model, 'Capacity': capacity, 'Color': color, 'Code': code,
                   'Type': 'iphone', 'PurchasePath': purchase_path, 'Price': int(amount),
                   'CatalogVerifiedAt': fetched}
        if family == 'iphoneduo':
            product['PreorderAt'] = PREORDER_AT
        records.append({'product': product, 'selection_index': index,
                        'selection': {key: source[key] for key in [
                            'partNumber', 'familyType', 'dimensionCapacity', 'dimensionColor', 'fullPrice']},
                        'official_color': official_color, 'href': matches[0],
                        'price': {key: price[key] for key in [
                            'product', 'partNumber', 'validProducts', 'priceCurrency', 'currentPrice', 'amountBeforeTradeIn']}})
    expected_count = 8 if slug == 'iphone-duo' else 32
    assert len(records) == expected_count
    assert len({row['product']['Code'] for row in records}) == expected_count
    for model in {row['product']['Model'] for row in records}:
        expected_colors = ['星光白色', '夜空色'] if model == 'iPhone Duo' else ['布根地红色', '冰川色', '银色', '黑色']
        assert {(row['product']['Capacity'], row['product']['Color']) for row in records
                if row['product']['Model'] == model} == set(itertools.product(CAPACITIES, expected_colors))
    return {**metadata, 'records': records}


def catalog_differences(catalog, verified_rows):
    differences = []
    existing = {}
    for model, products in catalog['products'].items():
        for product in products:
            code = product['Code']
            if code in existing:
                differences.append({'code': code, 'field': 'Code', 'issue': 'duplicate_catalog_sku'})
            if product.get('Model') != model:
                differences.append({'code': code, 'field': 'Model', 'issue': 'incorrect_model_group'})
            existing[code] = product
    verified = {product['Code']: product for product in verified_rows}
    for code in sorted(set(existing) | set(verified)):
        if code not in existing:
            differences.append({'code': code, 'issue': 'missing_from_catalog'})
        elif code not in verified:
            differences.append({'code': code, 'issue': 'absent_from_official_sources'})
        else:
            for field in PRODUCT_FIELDS:
                if existing[code].get(field) != verified[code].get(field):
                    differences.append({'code': code, 'field': field,
                                        'catalog': existing[code].get(field),
                                        'official': verified[code].get(field)})
    return differences


def write_bundle(catalog, evidence):
    # Stage both complete documents before replacing either published file.
    # Restore original bytes if a replacement raises; a process/power failure is
    # not a cross-file transaction and must be checked with catalog.test.js.
    payloads = {CATALOG: catalog, ROOT / 'catalog_verified.json': evidence}
    originals = {path: path.read_bytes() if path.exists() else None for path in payloads}
    staged = {}
    replaced = []
    try:
        for path, payload in payloads.items():
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', newline='\n',
                                             dir=str(path.parent), prefix=path.name + '.',
                                             suffix='.tmp', delete=False) as handle:
                staged[path] = Path(handle.name)
                handle.write(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
        for path, temporary in staged.items():
            os.replace(str(temporary), str(path))
            replaced.append(path)
    except Exception:
        for path in reversed(replaced):
            if originals[path] is None:
                path.unlink()
            else:
                path.write_bytes(originals[path])
        raise
    finally:
        for temporary in staged.values():
            if temporary.exists():
                temporary.unlink()


def main(argv=None):
    if not __debug__:
        raise RuntimeError('Verification requires Python assertions; do not run with -O or PYTHONOPTIMIZE.')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--write-catalog', '--update-catalog', dest='write_catalog', action='store_true',
                        help='Write both catalog and matching evidence after verification (--update-catalog is a compatibility alias).')
    args = parser.parse_args(argv)
    preorder = verify_preorder()
    sources = [extract(slug) for slug in ['iphone-18-pro', 'iphone-duo']]
    rows = [record['product'] for source in sources for record in source['records']]
    assert len(rows) == len({row['Code'] for row in rows}) == 40, 'Expected 40 unique official SKUs'
    catalog = json.loads(CATALOG.read_text(encoding='utf-8-sig'))
    differences = catalog_differences(catalog, rows)
    groups = {}
    for model in ['iPhone 18 Pro', 'iPhone 18 Pro Max', 'iPhone Duo']:
        colors = ['布根地红色', '冰川色', '银色', '黑色'] if model != 'iPhone Duo' else ['夜空色', '星光白色']
        groups[model] = sorted((row for row in rows if row['Model'] == model),
                               key=lambda row: (CAPACITIES.index(row['Capacity']), colors.index(row['Color'])))
        assert len(groups[model]) == (8 if model == 'iPhone Duo' else 16), 'Unexpected model count'
    evidence = {'verified_product_count': len(rows), 'sources': sources,
                'preorder': {**preorder, 'store_source_url': sources[1]['source_url'],
                             'store_announcement': PREORDER_TEXT},
                'limitations': ['Public catalog metadata only; no inventory request or cart mutation.',
                                'Published price and preorder date may change; verify again before ordering.',
                                'PurchasePath is copied from an official href matched to exact model, capacity and color.']}
    if args.write_catalog:
        catalog.update({'update_time': max(source['fetched_at'] for source in sources),
                        'source_url': sources[0]['source_url'],
                        'source_urls': [source['source_url'] for source in sources],
                        'products': groups, 'pending_products': []})
        write_bundle(catalog, evidence)
    print(json.dumps({'verified_product_count': len(rows), 'counts': {k: len(v) for k, v in groups.items()},
                      'catalog_updated': args.write_catalog, 'catalog_matches': not differences,
                      'differences': differences, 'preorder_evidence': preorder}))
    return 0 if args.write_catalog or not differences else 2


if __name__ == '__main__':
    raise SystemExit(main())
