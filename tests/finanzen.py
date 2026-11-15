"""Test der Finanz-App im echten Chrome. Aufruf im Repo-Ordner: python3 tests/finanzen.py (Windows: py)"""
import asyncio, json, os, pathlib, shutil, subprocess, sys, datetime
from playwright.async_api import async_playwright
HERE = pathlib.Path(__file__).resolve().parent; TPL = HERE.parent
CHROME = os.environ.get('CHROME_PATH', '/usr/bin/google-chrome')
WWW = pathlib.Path('/tmp/fin-test-www'); R = []
PW = 'Finanz-Passwort-1'
def check(name, ok, info=''):
    R.append((name, bool(ok), str(info))); print(('OK   ' if ok else 'FAIL ') + name + (f'  ({info})' if info else ''))
async def wait_true(page, expr, timeout=15000):
    import time
    end = time.time() + timeout / 1000
    while time.time() < end:
        if await page.evaluate(expr): return
        await asyncio.sleep(0.15)
    raise TimeoutError(expr)
async def add(page, name, amount, expense=False, fixed=False, category=None):
    await page.click('#fabBtn'); await page.wait_for_selector('#entryDialog[open]')
    if expense: await page.click('#toggleExpense')
    await page.fill('#entryName', name); await page.fill('#entryAmount', amount)
    if category: await page.select_option('#entryCategory', category)
    if fixed: await page.check('#entryFixed')
    await page.click('#entrySave'); await page.wait_for_selector('#entryDialog', state='hidden')
async def unlock(page):
    await page.wait_for_selector('.cp-lock'); await page.fill('#cpLockSecret', PW); await page.click('#cpLockSubmit'); await page.wait_for_selector('.cp-lock', state='detached')
async def main():
    out = subprocess.run(['node', str(TPL/'tools/stamp.mjs'), '--out', '_site'], capture_output=True, text=True); assert out.returncode == 0, out.stderr
    shutil.rmtree(WWW, ignore_errors=True); shutil.copytree(TPL/'_site', WWW/'app'); shutil.rmtree(TPL/'_site')
    srv = subprocess.Popen([sys.executable, str(HERE/'server.py'), str(WWW), '8180'], stderr=subprocess.DEVNULL); await asyncio.sleep(0.8)
    try:
        async with async_playwright() as p:
            b = await p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
            ctx = await b.new_context(viewport={'width': 412, 'height': 915}, accept_downloads=True)
            page = await ctx.new_page(); errors = []
            page.on('pageerror', lambda e: errors.append(str(e))); page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
            await page.goto('http://localhost:8180/app/'); await page.wait_for_selector('.cp-lock')
            check('Erststart: Passwort wird verlangt, Standard ist Passwort', 'Passwort' in await page.text_content('.cp-lock'))
            await page.fill('#cpLockSecret', PW); await page.fill('#cpLockRepeat', PW); await page.click('#cpLockSubmit'); await page.wait_for_selector('.cp-lock', state='detached')
            await add(page, 'Gehalt', '2.500,00', fixed=True)
            await add(page, 'Miete', '800', expense=True, fixed=True, category='Wohnen & Nebenkosten')
            await add(page, 'Einkauf GEHEIMMARKT', '123,45', expense=True, category='Lebensmittel')
            await add(page, 'Flohmarkt', '50,5')
            check('Kopf: Einnahmen 2.550,50, Ausgaben 923,45, Verfügbar 1.627,05', [await page.text_content(s) for s in ('#hdrIncome', '#hdrExpense', '#hdrBalance')] == ['2.550,50 €', '923,45 €', '1.627,05 €'], str([await page.text_content(s) for s in ('#hdrIncome', '#hdrExpense', '#hdrBalance')]))
            await asyncio.sleep(0.6)
            leg = await page.text_content('#chartLegend')
            check('Diagramm: Legende mit Anteilen (87 % / 13 %), Chart.js aus vendor/', '87 %' in leg and '13 %' in leg and await page.evaluate("typeof Chart === 'function' && [...document.scripts].some(s => s.src.endsWith('vendor/chart.umd.js'))"), leg)
            await page.screenshot(path='/tmp/fin-uebersicht.png')
            await page.click('[data-nav="income"]')
            check('Einnahmen-Liste: nur einmalige (Flohmarkt), Fixposten nicht doppelt', await page.evaluate("[...document.querySelectorAll('#incomeList .entry__name')].map(n => n.textContent).join('|')") == 'Flohmarkt')
            await page.click('[data-nav="fixed"]'); fx = await page.text_content('#fixedList')
            check('Fix-Liste: Gehalt und Miete mit Tag', 'Gehalt' in fx and 'Miete' in fx and 'jeden' in fx)
            # ungültige Eingabe
            await page.click('#fabBtn'); await page.fill('#entryName', 'X'); await page.fill('#entryAmount', 'abc'); await page.click('#entrySave')
            check('Ungültiger Betrag wird abgelehnt', 'gültigen Betrag' in await page.text_content('#entryError')); await page.click('#entryCancel')
            # nächster Monat: Fixposten übernommen, Übertrag
            nxt = (datetime.date.today().replace(day=1) + datetime.timedelta(days=32)).strftime('%Y-%m')
            await page.select_option('#monthSelect', nxt); await asyncio.sleep(0.4)
            vals = [await page.text_content(s) for s in ('#hdrIncome', '#hdrExpense', '#hdrBalance')]
            check('Folgemonat: Fixposten übernommen, Übertrag 1.627,05 eingerechnet', vals == ['2.500,00 €', '800,00 €', '3.327,05 €'] and '1.627,05' in await page.text_content('#carryRow'), str(vals))
            # Speicher verschlüsselt
            dump = await page.evaluate("Object.entries(localStorage).map(([k,v]) => k + '=' + v).join('\\n')")
            check('Speicher: nichts im Klartext, Keys mit meine-finanzen.', 'GEHEIMMARKT' not in dump and 'Miete' not in dump and PW not in dump and 'meine-finanzen.entries=' in dump and 'fin_' not in dump)
            # Neustart
            await page.reload(); await unlock(page)
            check('Neustart + Entsperren: gewählter Monat und Daten erhalten', (await page.input_value('#monthSelect')) == nxt and (await page.text_content('#hdrBalance')) == '3.327,05 €')
            # Fixposten löschen
            await page.click('[data-nav="fixed"]'); await page.click('#fixedList [aria-label="Miete löschen"]'); await page.click('#confirmYes'); await asyncio.sleep(0.3)
            check('Fixposten löschen entfernt ihn aus allen Monaten', (await page.text_content('#hdrExpense')) == '0,00 €' and 'Miete' not in await page.text_content('#fixedList'))
            # Kategorien
            await page.click('[data-nav="more"]'); await page.fill('#newExpenseCat', 'Haustiere'); await page.click('#expenseCatForm button'); await asyncio.sleep(0.3)
            check('Kategorie hinzufügen, Standard-Kategorien nicht löschbar', 'Haustiere' in await page.text_content('#expenseCatList') and await page.is_disabled('#expenseCatList [aria-label="Kategorie Lebensmittel löschen"]'))
            # verschlüsseltes Backup
            await page.click('#exportBtn'); await page.wait_for_selector('#cpSecretDialog[open]'); await page.fill('#cpSecretInput', 'Backup-Wort-77'); await page.fill('#cpSecretRepeat', 'Backup-Wort-77')
            async with page.expect_download() as dl: await page.click('#cpSecretOk')
            d = await dl.value; await d.save_as('/tmp/fin-backup.json'); txt = open('/tmp/fin-backup.json').read()
            check('Backup: Datei meine-finanzen-backup-…, verschlüsselt', d.suggested_filename.startswith('meine-finanzen-backup-') and '"pbkdf2-aes-gcm"' in txt and 'GEHEIMMARKT' not in txt and 'Gehalt' not in txt)
            # altes Backup der bisherigen App (Klartext, mit altem PIN) einspielen
            old = {"version": 1, "exported": "2026-05-27T10:00:00.000Z", "fin_pin": "4711", "fin_month": "2026-05",
                   "fin_income_cats": ["Gehalt / Lohn", "Bundeswehr", "Sonstiges", "Nebenjob"], "fin_expense_cats": ["Wohnen & Nebenkosten", "Lebensmittel"],
                   "fin_entries": [{"id": 1716800000000.12, "name": "Altgehalt", "amount": 1000, "type": "income", "category": "Gehalt / Lohn", "fixed": False, "month": "2026-05", "date": "2026-05-01"},
                                   {"id": 1716800000001.5, "name": "Altmiete", "amount": 400, "type": "expense", "category": "Wohnen & Nebenkosten", "fixed": False, "month": "2026-05", "date": "2026-05-03"}]}
            open('/tmp/fin-alt.json', 'w').write(json.dumps(old))
            await page.evaluate("document.querySelector('.cp-notice[data-notice-id=toast]')?.remove()")
            await page.set_input_files('#importFile', '/tmp/fin-alt.json'); await page.wait_for_selector('#confirmDialog[open]')
            check('Altes Backup wird erkannt', 'altes Format' in await page.text_content('#confirmText'))
            async with page.expect_navigation(): await page.click('#confirmYes')
            await unlock(page)
            vals = [await page.text_content(s) for s in ('#hdrIncome', '#hdrExpense', '#hdrBalance')]
            dump = await page.evaluate("Object.entries(localStorage).map(([k,v]) => k + '=' + v).join('\\n')")
            check('Altes Backup: Monat Mai 2026, 1.000 / 400 / 600, Kategorie „Nebenjob“ da', (await page.input_value('#monthSelect')) == '2026-05' and vals == ['1.000,00 €', '400,00 €', '600,00 €'], str(vals))
            check('Altes Backup: liegt verschlüsselt, alter PIN nirgends', 'Altgehalt' not in dump and '4711' not in dump and 'pin' not in dump.lower().replace('_restorepoint', ''))
            await page.click('[data-nav="income"]'); await page.click('#incomeList [aria-label="Altgehalt löschen"]'); await asyncio.sleep(0.3)
            check('Eintrag mit alter Zahlen-id lässt sich löschen', (await page.text_content('#hdrIncome')) == '0,00 €')
            # Installierbarkeit, CSP, Konsole
            m = await page.evaluate("fetch('manifest.webmanifest').then(r => r.json())")
            check('Manifest: Name, id "/", drei Icons', m['name'] == 'Meine Finanzen' and m['id'] == '/' and len(m['icons']) == 3)
            check('Service Worker aktiv, Cache meine-finanzen@…', await page.evaluate("navigator.serviceWorker.ready.then(() => caches.keys()).then(k => k.length === 1 && k[0].startsWith('meine-finanzen@'))"))
            await ctx.set_offline(True); await page.reload(); await unlock(page); await asyncio.sleep(0.5)
            check('Offline-Start inklusive Chart.js', await page.evaluate("typeof Chart === 'function'") and (await page.text_content('#hdrExpense')) == '400,00 €')
            await ctx.set_offline(False)
            check('Keine Fehler, keine Verstöße gegen die Sicherheitsregel', not errors, '; '.join(errors)[:300])
            await page.click('[data-nav="overview"]'); await asyncio.sleep(0.5); await page.screenshot(path='/tmp/fin-mai.png')
            await b.close()
    finally: srv.terminate()
    bad = [r for r in R if not r[1]]; print(f'\n{len(R)-len(bad)}/{len(R)} bestanden'); sys.exit(1 if bad else 0)
asyncio.run(main())
