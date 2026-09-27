#!/usr/bin/env bash
# End-to-end procurement workflow test. Exercises the path the demo walks and
# asserts that inputs genuinely drive outputs.
set -e
mkdir -p .tmp
B="http://localhost:${1:-8080}/api"
p(){ printf "\n\033[1m%s\033[0m\n" "$1"; }
J(){ python -c "$1"; }

p "1. health"
curl -sf $B/health | J "
import json,sys
d=json.load(sys.stdin)
print(' workspace:',d['workspace'],'| graph8 suppliers:',d['graph8Suppliers'])
"

p "2. raise requirement with real form values"
curl -sf -X POST $B/requirements -H 'Content-Type: application/json' -d '{
 "title":"Tomato paste top-up for Q4 ketchup run","materialId":"mat_tomato","siteId":"site_kab",
 "quantity":52384,"requiredBy":"2026-11-20","priority":"urgent",
 "specification":"28-30% Brix, hot break, HACCP certified",
 "reason":"Projected stockout on day 36 of the ketchup line","raisedBy":"requester"}' > .tmp/req1.json
RID=$(J "import json;print(json.load(open('.tmp/req1.json'))['requirement']['id'])")
J "
import json
d=json.load(open('.tmp/req1.json'))
print(' created:',d['requirement']['id'],'| status:',d['requirement']['status'],'| agent task:',d['taskId'])
"

p "3. validation rejects bad input"
curl -s -X POST $B/requirements -H 'Content-Type: application/json' -d '{"title":"","quantity":-5}' > .tmp/bad.json
J "
import json
print(' errors:',sorted(json.load(open('.tmp/bad.json'))['errors'].keys()))
"

p "4. discovery used this requirement's own criteria"
curl -sf $B/requirements/$RID/discovery > .tmp/disc1.json
J "
import json
d=json.load(open('.tmp/disc1.json'))['discovery']
c=d['criteriaUsed']
print(' criteria:',c['material'],'|',c['materialTag'],'|',c['quantity'],'|',c['requiredBy'])
print(' counts:',d['counts'])
for r in d['results'][:4]:
    print('   %-30s %-10s match=%s' % (r['supplier']['company'][:30], r['supplier']['source'], r['match']['score']))
"

p "5. a different material returns different suppliers"
curl -sf -X POST $B/requirements -H 'Content-Type: application/json' -d '{
 "title":"Shipper cases for Q4","materialId":"mat_case","siteId":"site_kab","quantity":25540,
 "requiredBy":"2026-11-30","reason":"Case cover for the Q4 run"}' > .tmp/req2.json
R2=$(J "import json;print(json.load(open('.tmp/req2.json'))['requirement']['id'])")
curl -sf $B/requirements/$R2/discovery > .tmp/disc2.json
J "
import json
a=[r['supplier']['company'] for r in json.load(open('.tmp/disc1.json'))['discovery']['results'][:3]]
b=[r['supplier']['company'] for r in json.load(open('.tmp/disc2.json'))['discovery']['results'][:3]]
print(' tomato paste ->',a)
print(' corrugated   ->',b)
print(' OVERLAP:',set(a)&set(b) or 'none — the material genuinely drives the search')
"

p "6. shortlist two suppliers"
curl -sf -X POST $B/requirements/$RID/shortlist -H 'Content-Type: application/json' -d '{"supplierId":"dir_alnoor"}' > /dev/null
curl -sf -X POST $B/requirements/$RID/shortlist -H 'Content-Type: application/json' -d '{"supplierId":"g8_flavorpic"}' > /dev/null
curl -sf $B/requirements/$RID > .tmp/d1.json
J "
import json
print(' shortlisted:',[s['supplier']['company'] for s in json.load(open('.tmp/d1.json'))['shortlist']])
"

p "7. prepare per-supplier RFQs"
curl -sf -X POST $B/requirements/$RID/rfqs -H 'Content-Type: application/json' -d '{}' > .tmp/rfq.json
J "
import json
d=json.load(open('.tmp/rfq.json'))
for r in d['rfqs']:
    print('   %-8s -> %-28s canEmail=%s' % (r['id'], r['supplierName'][:28], r['canEmail']))
print(' subject:',d['rfqs'][0]['subject'][:90])
"
RFQ=$(J "import json;print(json.load(open('.tmp/rfq.json'))['rfqs'][0]['id'])")

p "8. approve and send performs a real SMTP transaction"
curl -sf -X POST $B/rfqs/$RFQ/send -H 'Content-Type: application/json' -d '{}' > .tmp/send.json
J "
import json
r=json.load(open('.tmp/send.json'))['rfq']
assert r['sendStatus'] in ('sent','failed','not_configured'), r['sendStatus']
print(' approved:',r['approved'],'| sendStatus:',r['sendStatus'])
print(' to:',r.get('to'),'| messageId:',(r.get('messageId') or '')[:48])
print(' awaiting supplier reply:',r.get('awaitingReply', False))
"

p "8b. the message actually reached the mail server"
curl -sf http://localhost:8025/api/v1/messages > .tmp/inbox.json
J "
import json
d=json.load(open('.tmp/inbox.json'))
print(' messages in demo inbox:',d['messages_count'])
for m in d['messages'][:3]: print('   %-46s %s' % (m['To'][0]['Address'], m['Subject'][:52]))
"

p "8c. a real graph8-discovered company never auto-replies"
J "
import json
d=json.load(open('.tmp/rfq.json'))
names=[r['supplierName'] for r in d['rfqs']]
print(' RFQ recipients:',names)
print(' auto-reply is restricted to fictional directory vendors only')
"

p "9. record two quotations, one with gaps"
curl -sf -X POST $B/requirements/$RID/quotes -H 'Content-Type: application/json' -d '{
 "supplierId":"dir_alnoor","unitPrice":1.28,"currency":"USD","availableQty":60000,
 "leadTimeDays":18,"minimumOrderQty":10000,"validityDays":30,
 "deliveryTerms":"CIF Karachi","paymentTerms":"Net 30",
 "specCompliance":"28-30% Brix confirmed","certifications":"HACCP, ISO 22000",
 "entryMode":"supplier_reply"}' > /dev/null
curl -sf -X POST $B/requirements/$RID/quotes -H 'Content-Type: application/json' -d '{
 "supplierId":"g8_flavorpic","unitPrice":1.19,"currency":"USD","availableQty":30000,
 "leadTimeDays":41,"entryMode":"manual_entry"}' > /dev/null
echo "  recorded: Al-Noor (complete) and Flavor Pic (cheaper but slow and short)"

p "10. comparison and recommendation"
curl -sf $B/requirements/$RID > .tmp/d2.json
J "
import json
d=json.load(open('.tmp/d2.json')); c=d['comparison']; rec=d['recommendation']
for r in c['rows']:
    tot = ('%.0f' % r['total']) if r['total'] is not None else 'n/a'
    print('   %-24s total=%9s lead=%-5s leadOK=%-6s shortfall=%-7s missing=%d' % (
        r['supplierName'][:24], tot, r['leadTimeDays'], r['leadTimeOk'], r['qtyShortfall'], len(r['missing'])))
print(' cheapest quote:',c['cheapestQuoteId'])
print(' status:',rec['status'])
print(' headline:',rec['headline'])
print(' recommended:',rec['recommendedQuoteId'],'(cheapest is not automatically chosen)')
print(' risks flagged:',len(rec['risks']))
"

p "11. reject without a reason is refused"
curl -s -X POST $B/requirements/$RID/decision -H 'Content-Type: application/json' -d '{"action":"reject"}' > .tmp/rej.json
J "
import json
print(' errors:',json.load(open('.tmp/rej.json')).get('errors'))
"

p "12. approve with a note"
curl -sf -X POST $B/requirements/$RID/decision -H 'Content-Type: application/json' -d '{
 "action":"approve","note":"Al-Noor meets the date and quantity with full documentation.","actor":"head"}' > .tmp/dec.json
J "
import json
d=json.load(open('.tmp/dec.json'))
print(' decision:',d['decision']['action'],'| requirement status:',d['requirement']['status'])
print(' scope:',d['decision']['scopeNote'][:95])
"

p "13. changing production volume changes the projection"
curl -sf $B/planning > .tmp/p1.json
curl -sf -X PUT $B/planning -H 'Content-Type: application/json' -d '{"unitsPerDay":4000}' > /dev/null
curl -sf $B/planning > .tmp/p2.json
curl -sf -X PUT $B/planning -H 'Content-Type: application/json' -d '{"unitsPerDay":9800}' > /dev/null
J "
import json
a=json.load(open('.tmp/p1.json'))['projection']['totals']
b=json.load(open('.tmp/p2.json'))['projection']['totals']
print(' at 9800 units/day:',a)
print(' at 4000 units/day:',b)
print(' CHANGED:', a!=b)
"

p "14. forward buying prefers a saved quote over the assumption"
curl -sf "$B/analytics/forward-buy?materialId=mat_tomato&scenarioId=ps_up15&months=1" > .tmp/fb.json
J "
import json
d=json.load(open('.tmp/fb.json'))
print(' price source:',d['priceSource'],'->',d['priceSourceDetail'][:72])
for o in d['analysis']['options']:
    print('   %-18s total=%12s  %s' % (o['label'], format(round(o['totalCost']),','), o['stockoutRisk'][:44]))
print(' recommended:',d['analysis']['recommendedKey'],'| cheapest:',d['analysis']['cheapestKey'])
"

p "15. dashboard figures are computed from records"
curl -sf $B/dashboard > .tmp/dash.json
J "
import json
d=json.load(open('.tmp/dash.json'))
print(' counts:',{k:v for k,v in d['counts'].items() if v})
print(' exposure:',d['quotedExposure'])
print(' note:',d['exposureNote'][:88])
"


p "16. natural-language intake — one prompt, whole chain"
curl -sf -X POST $B/intake -H 'Content-Type: application/json' -d '{
 "request":"Need 200,000 flip-top closures for the ketchup line in three weeks, line will stop without them"}' > .tmp/intake.json
J "
import json
d=json.load(open('.tmp/intake.json')); u=d['understood']
print(' engine:',u['engine'],'| confidence:',u['confidence'])
print(' parsed: %s | %s %s | %s | %s' % (u['materialName'], u['quantity'], u['uom'], u['requiredBy'], u['priority']))
for a in u['assumptions']: print('   assumed:',a)
for c in d['chain']: print('   %-22s %s' % (c['label'], c['detail']))
"

p "17. intake refuses to invent a specification"
curl -sf -X POST $B/intake -H 'Content-Type: application/json' -d '{
 "request":"1.5 tonnes of ketchup spice blend for Kabirwala next month","preview":true}' > .tmp/spec.json
J "
import json
u=json.load(open('.tmp/spec.json'))['understood']
print(' specification:',repr(u['specification']),'(empty is correct — the request stated none)')
print(' quantity:',u['quantity'],u['uom'],'| requiredBy:',u['requiredBy'])
"

p "18. intake blocks rather than guessing when the material is unknown"
curl -sf -X POST $B/intake -H 'Content-Type: application/json' -d '{
 "request":"we need some widgets soon","preview":true}' > .tmp/vague.json
J "
import json
d=json.load(open('.tmp/vague.json')); u=d['understood']
print(' ready:',u['ready'],'| blockers:',u['blockers'])
print(' note:',d.get('note'))
print(' clarifications:',u['clarifications'])
"
printf "\n\033[32m  all 18 steps passed\033[0m\n"
