#!/usr/bin/env python3
"""Refresh hyros_spend cache: for every funnel_ad_source with provider='hyros',
sum Facebook adset `cost` from dash_config.fresh_start -> today, upsert into hyros_spend.
Runs on the local host (has Hyros key); dashboard on Render just reads the table.
Scheduled hourly via cron."""
import urllib.request, json, datetime, os

CRED = os.path.expanduser('~/.openclaw/credentials')
HKEY = open(f'{CRED}/hyros-api-key.txt').read().strip()
SKEY = open(f'{CRED}/supabase-service-role-copywriter.txt').read().strip()
SB = 'https://cmefzycouallezhohvro.supabase.co'

def hy(url):
    r = urllib.request.Request(url, headers={'API-Key': HKEY})
    return json.load(urllib.request.urlopen(r, timeout=60))

def sb(path, method='GET', body=None, prefer=None):
    h = {'apikey': SKEY, 'Authorization': f'Bearer {SKEY}', 'Content-Type': 'application/json'}
    if prefer: h['Prefer'] = prefer
    r = urllib.request.Request(f'{SB}/rest/v1/{path}', headers=h, method=method,
                               data=json.dumps(body).encode() if body is not None else None)
    resp = urllib.request.urlopen(r, timeout=30); return json.load(resp) if resp.length else []

def adset_ids(acc):
    ids, after, p = [], None, 0
    while p < 20:
        d = hy('https://api.hyros.com/v1/api/v1.0/sources?pageSize=250' + (f'&pageId={after}' if after else '')); p += 1
        for s in d.get('result', []):
            a = s.get('adSource') or {}
            if a.get('adAccountId') == acc and a.get('adSourceId'): ids.append(a['adSourceId'])
        after = d.get('nextPageId')
        if not after: break
    return list(set(ids))

def spend(acc, start, end):
    ids = adset_ids(acc); tot = 0.0
    for i in range(0, len(ids), 40):
        b = ids[i:i+40]
        u = (f'https://api.hyros.com/v1/api/v1.0/attribution?startDate={start}&endDate={end}'
             f'&attributionModel=last_click&fields=cost&ids={",".join(b)}&level=facebook_adset')
        try:
            for r in hy(u).get('result', []): tot += float(r.get('cost') or 0)
        except Exception as e: print('  batch err', e)
    return round(tot, 2)

def main():
    cfg = sb('dash_config?key=eq.fresh_start&select=value')
    start = (cfg[0]['value'][:10] if cfg else '2026-10-09')
    end = datetime.date.today().isoformat()
    srcs = sb("funnel_ad_source?provider=eq.hyros&select=account_id")
    accts = sorted({s['account_id'] for s in srcs if s.get('account_id')})
    print(f'refresh hyros_spend {start}..{end} for {len(accts)} acct(s)')
    for acc in accts:
        v = spend(acc, start, end)
        sb('hyros_spend', 'POST', [{'account_id': acc, 'spend': v, 'window_start': start,
                                    'updated_at': datetime.datetime.utcnow().isoformat()}],
           prefer='resolution=merge-duplicates,return=minimal')
        print(f'  {acc} -> ${v}')

if __name__ == '__main__':
    main()
