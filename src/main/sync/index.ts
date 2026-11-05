import dayjs from 'dayjs'
import { fetchAlerts } from '../mail/gmail'
import { parseHdfcAlert } from '../parsers/hdfc-email'
import { insertTransaction } from '../db/repo/transactions'
import { accountByBank } from '../db/repo/accounts'
import { getSetting, setSetting } from '../db/repo/settings'
import { getDb } from '../db/connection'
import { checkBudgetsAndNotify } from './budget-alerts'
import type { SyncResult } from '@shared/types'
import { isBeforeTrackingStart, trackingStart } from '../core/tracking-start'

let running: Promise<SyncResult> | null = null

/** Pull new HDFC alert emails and turn them into transactions. Serialized: concurrent calls share one run. */
export function runSync(): Promise<SyncResult> {
  if (running) return running
  running = doSync().finally(() => {
    running = null
  })
  return running
}

async function doSync(): Promise<SyncResult> {
  const result: SyncResult = {
    fetched: 0,
    inserted: 0,
    skippedDuplicate: 0,
    skippedSuppressed: 0,
    skippedNonTransaction: 0,
    skippedBeforeStart: 0,
    needsReview: 0,
    errors: [],
    budgetAlerts: [],
    finishedAt: ''
  }
  const account = accountByBank('HDFC')
  if (!account) throw new Error('HDFC account row is missing')

  const lastSyncAt = getSetting('gmail_last_sync_at')
  const start = trackingStart()
  const afterUid = Number(getSetting('gmail_last_uid') ?? 0)
  // Overlap 3 days with the last run to catch late-arriving mail, but never go before the tracking start.
  // A run that never fetched anything (cursor still 0, e.g. the sender address was wrong) is not a
  // baseline: start from the tracking start again so nothing in between is skipped.
  const overlap = lastSyncAt && afterUid > 0 ? dayjs(lastSyncAt).subtract(3, 'day') : dayjs(start)
  const since = (overlap.isBefore(dayjs(start)) ? dayjs(start) : overlap).toDate()

  const insertedIds: number[] = []
  const { fetched, maxUid, uidValidity } = await fetchAlerts({
    since,
    afterUid,
    onMessage: ({ uid, internalDate, mail }) => {
      const parsed = parseHdfcAlert({
        subject: mail.subject ?? null,
        text: mail.text ?? null,
        html: typeof mail.html === 'string' ? mail.html : null,
        date: mail.date ?? internalDate
      })
      if (!parsed) {
        result.skippedNonTransaction++
        return
      }
      if (isBeforeTrackingStart(parsed.postedAt)) {
        result.skippedBeforeStart++
        return
      }
      const out = insertTransaction({
        accountId: account.id,
        postedAt: parsed.postedAt,
        amountPaise: parsed.amountPaise,
        direction: parsed.direction,
        payee: parsed.payee,
        vpa: parsed.vpa,
        narration: parsed.narration,
        refNo: parsed.refNo,
        channel: parsed.channel,
        source: 'email',
        needsReview: parsed.confidence === 'low',
        emailUid: uid
      })
      if (out.status === 'inserted') {
        insertedIds.push(out.txn.id)
        result.inserted++
        if (out.txn.needsReview) result.needsReview++
      } else if (out.status === 'duplicate') result.skippedDuplicate++
      else result.skippedSuppressed++
    },
    onError: (uid, err) => {
      // Never log message content; the UID is enough to find it in Gmail.
      result.errors.push(`Email UID ${uid}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
  result.fetched = fetched

  const prevValidity = getSetting('gmail_uidvalidity')
  if (uidValidity && prevValidity && prevValidity !== uidValidity) {
    // Mailbox UIDs were renumbered; next run must not trust the stored UID, and older rows' UIDs
    // now point at other messages (trash-on-delete would bin the wrong email).
    setSetting('gmail_last_uid', '0')
    const keep = insertedIds.length ? `AND id NOT IN (${insertedIds.join(',')})` : ''
    getDb().prepare(`UPDATE transactions SET email_uid = NULL WHERE email_uid IS NOT NULL ${keep}`).run()
  } else {
    setSetting('gmail_last_uid', String(maxUid))
  }
  if (uidValidity) setSetting('gmail_uidvalidity', uidValidity)
  result.finishedAt = dayjs().format('YYYY-MM-DDTHH:mm:ss')
  setSetting('gmail_last_sync_at', result.finishedAt)

  result.budgetAlerts = checkBudgetsAndNotify()
  return result
}
