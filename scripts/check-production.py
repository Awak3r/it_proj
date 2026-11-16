#!/usr/bin/python3
"""Read-only HTTP acceptance checks. HTTPS validation is never disabled."""
import argparse
import json
import re
import urllib.error
import urllib.parse
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', default='https://labturn.awak3r.ru')
    options = parser.parse_args()
    base = options.origin.rstrip('/')
    expected = [('/api/health', {'ok': True}), ('/api/config', {'dev_auth': False})]
    for path, data in expected:
        with urllib.request.urlopen(base + path, timeout=15) as response:
            assert response.status == 200 and json.load(response) == data
            print(path, 200, data, flush=True)
    variants = [{}, {'X-Dev-User': '1297278646'}, {'Authorization': 'tma invalid'},
                {'X-Dev-User': '1297278646', 'Authorization': 'tma invalid'}]
    for path in ['/api/state', '/api/updates']:
        for headers in variants:
            try:
                with urllib.request.urlopen(urllib.request.Request(base + path, headers=headers),
                                            timeout=10) as response:
                    code = response.status
            except urllib.error.HTTPError as error:
                code = error.code
            assert code == 401, f'{path} returned {code}, expected 401'
            print(path, list(headers) or 'no authorization', code, flush=True)
    with urllib.request.urlopen(base + '/', timeout=15) as response:
        html = response.read().decode()
        assert response.status == 200 and '<html' in html
        assert response.headers.get_content_type() == 'text/html'
        print('HTML', response.status, flush=True)
    assets = re.findall(r'(?:src|href)="(/assets/[^\"]+)"', html)
    assert any(asset.endswith('.js') for asset in assets), 'Missing JS asset'
    assert any(asset.endswith('.css') for asset in assets), 'Missing CSS asset'
    for asset in assets:
        url = urllib.parse.urljoin(base + '/', asset)
        with urllib.request.urlopen(url, timeout=15) as response:
            content = response.read()
            assert response.status == 200 and len(content) > 0
            assert response.headers.get_content_type() != 'text/html'
            print(asset, response.status, len(content), response.headers.get('Content-Type'),
                  flush=True)
    print('Read-only HTTP checks passed. Telegram login/SSE evidence is recorded separately.')


if __name__ == '__main__':
    main()
