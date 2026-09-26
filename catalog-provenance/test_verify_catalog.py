"""Offline regression checks; all catalog mutations use temporary test copies."""
import contextlib
import copy
import io
import json
import pathlib
import tempfile
import unittest
from unittest import mock

import verify_catalog as verifier


class CatalogVerificationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='apple-catalog-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.catalog_path = self.root / 'product_data_hk.json'
        self.evidence_path = self.root / 'catalog_verified.json'
        self.catalog_path.write_bytes(verifier.CATALOG.read_bytes())
        self.evidence_path.write_bytes((verifier.ROOT / 'catalog_verified.json').read_bytes())
        self.catalog = json.loads(self.catalog_path.read_text(encoding='utf-8-sig'))
        self.evidence = json.loads(self.evidence_path.read_text(encoding='utf-8-sig'))
        self.sources = copy.deepcopy(self.evidence['sources'])
        for source in self.sources:
            source['fetched_at'] = '2026-09-23T00:00:00+00:00'
            for record in source['records']:
                record['product']['CatalogVerifiedAt'] = source['fetched_at']
        self.preorder = {**self.evidence['preorder'], 'date_published': '2026-09-09Z'}

    def run_main(self, args):
        output = io.StringIO()
        with mock.patch.object(verifier, 'ROOT', self.root), \
                mock.patch.object(verifier, 'CATALOG', self.catalog_path), \
                mock.patch.object(verifier, 'verify_preorder', return_value=self.preorder), \
                mock.patch.object(verifier, 'extract', side_effect=copy.deepcopy(self.sources)), \
                contextlib.redirect_stdout(output):
            result = verifier.main(args)
        return result, json.loads(output.getvalue())

    def test_default_preserves_catalog_and_evidence_bytes_when_fetch_time_changes(self):
        before = (self.catalog_path.read_bytes(), self.evidence_path.read_bytes())
        result, report = self.run_main([])
        self.assertEqual(result, 0)
        self.assertTrue(report['catalog_matches'])
        self.assertFalse(report['catalog_updated'])
        self.assertEqual(report['verified_product_count'], 40)
        self.assertEqual(before, (self.catalog_path.read_bytes(), self.evidence_path.read_bytes()))

    def test_default_reports_duo_price_path_and_preorder_differences_without_writes(self):
        duo = self.catalog['products']['iPhone Duo'][0]
        duo.update(Price=1, PurchasePath='/wrong', PreorderAt='2026-10-17T20:00:00+08:00')
        self.catalog_path.write_text(json.dumps(self.catalog), encoding='utf-8')
        before = (self.catalog_path.read_bytes(), self.evidence_path.read_bytes())
        result, report = self.run_main([])
        self.assertEqual(result, 2)
        self.assertEqual({row['field'] for row in report['differences']},
                         {'Price', 'PurchasePath', 'PreorderAt'})
        self.assertEqual(before, (self.catalog_path.read_bytes(), self.evidence_path.read_bytes()))

    def test_explicit_write_updates_both_copies_to_matching_forty_products(self):
        result, report = self.run_main(['--write-catalog'])
        self.assertEqual(result, 0)
        self.assertTrue(report['catalog_updated'])
        catalog = json.loads(self.catalog_path.read_text(encoding='utf-8'))
        evidence = json.loads(self.evidence_path.read_text(encoding='utf-8'))
        published = {row['Code']: row for rows in catalog['products'].values() for row in rows}
        verified = {record['product']['Code']: record['product']
                    for source in evidence['sources'] for record in source['records']}
        self.assertEqual(len(published), 40)
        self.assertEqual(published, verified)
        self.assertEqual(evidence['preorder']['date_published'], '2026-09-09Z')
        self.assertEqual(list(self.root.glob('*.tmp')), [])

    def test_write_restores_originals_when_second_replacement_fails(self):
        before = (self.catalog_path.read_bytes(), self.evidence_path.read_bytes())
        real_replace = verifier.os.replace
        calls = []

        def fail_second(source, target):
            calls.append(target)
            if len(calls) == 2:
                raise OSError('simulated write failure')
            return real_replace(source, target)

        with mock.patch.object(verifier.os, 'replace', side_effect=fail_second):
            with self.assertRaisesRegex(OSError, 'simulated write failure'):
                self.run_main(['--write-catalog'])
        self.assertEqual(before, (self.catalog_path.read_bytes(), self.evidence_path.read_bytes()))
        self.assertEqual(list(self.root.glob('*.tmp')), [])

    def test_removed_sku_and_duplicate_are_reported(self):
        rows = [record['product'] for source in self.sources for record in source['records']]
        duo = self.catalog['products']['iPhone Duo']
        missing_code = duo[-1]['Code']
        duo[-1] = copy.deepcopy(duo[0])
        differences = verifier.catalog_differences(self.catalog, rows)
        self.assertTrue(any(row.get('issue') == 'duplicate_catalog_sku' for row in differences))
        self.assertIn({'code': missing_code, 'issue': 'missing_from_catalog'}, differences)

    def test_newsroom_requires_dated_article_and_explicit_hong_kong_time(self):
        article = {'@type': 'NewsArticle', 'mainEntityOfPage': verifier.PREORDER_NEWS_URL,
                   'datePublished': '2026-09-09Z'}
        visible = '2026 年 9 月 9 日 香港時間 10 月 16 日 (星期五) 晚上 8 時起'

        def document(metadata, body):
            return '<script type="application/ld+json">' + json.dumps(metadata) + '</script>' + body

        with mock.patch.object(verifier, 'fetch_document', return_value=(document(article, visible), {})):
            self.assertEqual(verifier.verify_preorder()['normalized'], '2026-10-16T20:00:00+08:00')
        bad_article = {**article, 'datePublished': '2025-09-09Z'}
        with mock.patch.object(verifier, 'fetch_document', return_value=(document(bad_article, visible), {})):
            with self.assertRaises(AssertionError):
                verifier.verify_preorder()
        with mock.patch.object(verifier, 'fetch_document', return_value=(document(article, visible.replace('香港時間', '')), {})):
            with self.assertRaises(AssertionError):
                verifier.verify_preorder()


if __name__ == '__main__':
    unittest.main()
