#!/usr/bin/python3
"""Validate bot identity and configure default or owner-only Web App menus."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.request

APP = Path('/home/ubuntu/labturn/source')
URL = 'https://labturn.awak3r.ru'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--configure', action='store_true')
    actions.add_argument('--owner-check', action='store_true')
    actions.add_argument('--restore-owner-menu', action='store_true')
    options = parser.parse_args()
    result = subprocess.run(
        ['docker', 'compose', '--project-name', 'labturn', '--profile', 'https',
         'config', '--format', 'json'], cwd=APP, capture_output=True, text=True)
    if result.returncode:
        sys.exit('Compose configuration failed; details suppressed to protect secrets')
    env = json.loads(result.stdout)['services']['app']['environment']
    token = env.get('BOT_TOKEN', '')
    if not token:
        sys.exit('BOT_TOKEN is empty; owner must enter it in .env')
    if env.get('DEV_AUTH') != 'false' or env.get('ROOT_TELEGRAM_IDS') != '1297278646':
        sys.exit('Unexpected authentication/root configuration')

    def api(method, payload=None):
        request = urllib.request.Request(
            f'https://api.telegram.org/bot{token}/{method}',
            data=json.dumps(payload or {}).encode(),
            headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=25) as response:
                data = json.load(response)
        except urllib.error.HTTPError as error:
            try:
                details = json.load(error)
                description = str(details.get('description', 'request rejected'))
                description = description.replace(token, '[redacted]')[:200]
            except Exception:
                description = 'response details suppressed'
            sys.exit(f'Telegram {method}: HTTP {error.code}; {description}')
        except Exception:
            # urllib exceptions may contain the token-bearing request URL.
            sys.exit(f'Telegram {method} failed; request details suppressed')
        if not data.get('ok'):
            sys.exit(f'Telegram {method} rejected; response details suppressed')
        return data['result']

    identity = api('getMe')
    if identity.get('username', '').lower() != 'labturn_bot':
        sys.exit('Token belongs to a different bot; no changes made')
    print('Validated bot: @labturn_bot')
    expected = {'type': 'web_app', 'text': 'Открыть LabTurn', 'web_app': {'url': URL}}
    scope = {}
    if options.owner_check or options.restore_owner_menu:
        scope = {'chat_id': 1297278646}
    if options.owner_check:
        expected = {'type': 'web_app', 'text': 'Проверить LabTurn',
                    'web_app': {'url': URL + '/owner-check.html'}}
    if options.configure or options.owner_check or options.restore_owner_menu:
        if api('setChatMenuButton', {**scope, 'menu_button': expected}) is not True:
            sys.exit('Menu update failed')
        actual = api('getChatMenuButton', scope)
        matches = (actual.get('type') == expected['type']
                   and actual.get('text') == expected['text']
                   and actual.get('web_app', {}).get('url', '').rstrip('/') == expected['web_app']['url'])
        if not matches:
            public_fields = {'type': actual.get('type'), 'text': actual.get('text'),
                             'url': actual.get('web_app', {}).get('url')}
            print('Returned menu fields:', json.dumps(public_fields, ensure_ascii=False))
            sys.exit('Menu verification failed')
        audience = 'owner-only' if scope else 'default'
        print(f"Verified {audience} menu: {expected['text']} -> {expected['web_app']['url']}")
        print('No messages sent; Main Mini App is configured separately in BotFather')


if __name__ == '__main__':
    main()
