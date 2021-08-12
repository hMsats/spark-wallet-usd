import big from 'big.js'
import { Observable as O } from './rxjs'
import { dbg, getChannels, formatAmt, recvAmt, parsePayment, combine, isConnError } from './util'

const msatbtc = big(100000000000) // msat in 1 btc

const
  sumChans = chans =>
    chans.filter(c => c.chan.state === 'CHANNELD_NORMAL')
         .reduce((T, c) => T + c.chan.msatoshi_to_us, 0)

, sumOuts = outs =>
    outs.filter(o => o.status === 'confirmed')
        .reduce((T, o) => T + o.value*1000, 0)

, fmtAlert = (s, unitf) => s.replace(/@\{\{(\d+)\}\}/g, (_, msat) => unitf(msat))

, idx = xs => x => xs.indexOf(x)
, idn = x => x

const
  themes   = 'cerulean cosmo cyborg dark flatly lumen lux materia sandstone simplex slate solar spacelab superhero united yeti'.split(' ')
, units    = 'sat bits milli BTC USD'.split(' ')
, unitprec = { sat: 3, bits: 5, milli: 8, BTC: 11, USD: 6 }
, unitrate = { sat: 0.001, bits: 0.00001, milli: 0.00000001, BTC: 0.00000000001 }
, unitstep = { ...unitrate, USD: 0.000001 }

module.exports = ({ dismiss$, togExp$, togTheme$, togUnit$, page$, goHome$, goRecv$, goChan$
                  , amtVal$, execRpc$, execRes$, clrHist$, feedStart$: feedStart_$, togFeed$, togChan$
                  , fundMaxChan$
                  , conf$: savedConf$
                  , req$$, error$, payreq$, incoming$, outgoing$, payments$, invoices$, funds$
                  , funded$, closed$
                  , offer$, offerPayQuantity$: offerPayQuantityInput$, invUseOffer$
                  , btcusd$, info$, lnconfig$, peers$ }) => {
  const

  // Config options
    conf     = (name, def, list) => savedConf$.first().map(c => c[name] || def).map(list ? idx(list) : idn)
  , expert$  = conf('expert', false)        .concat(togExp$)  .scan(x => !x)
  , theme$   = conf('theme', 'dark', themes).concat(togTheme$).scan(n => (n+1) % themes.length).map(n => themes[n])
  , unit$    = conf('unit',  'bits',  units).concat(togUnit$) .scan(n => (n+1) % units.length) .map(n => units[n])
  , conf$    = combine({ expert$, theme$, unit$ })

  // Currency & unit conversion handling
  , msatusd$ = btcusd$.map(rate => big(rate).div(msatbtc)).startWith(null)
  , rate$    = O.combineLatest(unit$, msatusd$, (unit, msatusd) => unitrate[unit] || msatusd)
  , unitf$   = O.combineLatest(unit$, msatusd$, unit_formatter)

  // Keep track of connection status
  , connected$ = req$$.flatMap(r$ => r$.mapTo(true).catch(_ => O.empty()))
      .merge(error$.filter(isConnError).mapTo(false))
      .startWith(false)
      .distinctUntilChanged()

  // Keep track of the number of user-initiated in-flight HTTP requests
  , inflight$ = req$$.filter(({ request: r }) => !(r.ctx && r.ctx.bg))
      .flatMap(r$ => r$.catch(_ => O.of(null)).mapTo(-1).startWith(+1))
      .startWith(0).scan((N, a) => N+a)

  // Show loading indicator if we have active in-flight foreground requests
  , loading$ = inflight$.map(inflight => inflight > 0)

  // User-visible alert messages
  , alert$ = O.merge(
      error$.map(err  => [ 'danger', ''+err ])
    , incoming$.map(i => [ 'success', `Received payment of @{{${recvAmt(i)}}}` ])
    , outgoing$.map(p => [ 'success', `Sent payment of @{{${p.msatoshi}}}` ])
    , funded$.map(c   => [ 'success', `Opening channel for @{{${c.chan.msatoshi_total}}}, awaiting on-chain confirmation` ])
    , closed$.map(c   => [ 'success', `Channel ${c.chan.short_channel_id || c.chan.channel_id} is closing` ])
    , dismiss$.mapTo(null)
    )
    // hide "connection lost" errors when we get back online
    .combineLatest(connected$, (alert, conn) => alert && (isConnError(alert[1]) && conn ? null : alert))
    // format msat amounts in messages
    .combineLatest(unitf$, (alert, unitf) => alert && [ alert[0], fmtAlert(alert[1], unitf) ])
    .startWith(null)

  // On-chain balance
  // TODO: patch with known outgoing payments
  , obalance$ = funds$.map(funds => sumOuts(funds.outputs))
      .distinctUntilChanged()

  // List of active channels
  // Periodically re-sync channel balance from "listpeers",
  // continuously patch with known channel opening/closing
  , channels$ = O.merge(
      peers$.map(peers => _ => getChannels(peers))
    , funded$.map(chan => S => [ ...S, chan ])
    , closed$.map(chan => S => [ ...S.filter(c => c.chan.channel_id != chan.chan.channel_id), chan ])
    ).startWith(null).scan((S, mod) => mod(S))
    .filter(Boolean)

  // Total channel balance
  // Periodically re-sync channel balance from "listpeers",
  // continuously patch with known incoming & outgoing payments
  , cbalance$ = O.merge(
      channels$.map(chans => _ => sumChans(chans))
    , incoming$.map(inv => N => N + inv.msatoshi_received)
    , outgoing$.map(pay => N => N - pay.msatoshi_sent)
    ).startWith(null).scan((N, mod) => mod(N)).distinctUntilChanged()

  // Periodically re-sync from listsendpays (completed only),
  // continuously patch with known outgoing payments
  , freshPays$ = O.merge(
      payments$.map(payments => _ =>
        payments.filter(p => p.status === 'complete').map(parsePayment))
    , outgoing$.map(pay => payments => payments &&
        [ ...payments.filter(p => p.payment_hash !== pay.payment_hash), pay ])
    )
    .startWith(null).scan((payments, mod) => mod(payments))
    .filter(Boolean)
    .distinctUntilChanged((prev, next) => prev.length === next.length)

  // Periodically re-sync from listinvoices (paid only),
  // continuously patch with known incoming payments
  , freshInvs$ = O.merge(
      invoices$.map(invs => _ => invs.filter(inv => inv.status == 'paid'))
    , incoming$.map(inv => invs => invs && [ ...invs, inv ])
    )
    .startWith(null).scan((invs, mod) => mod(invs))
    .filter(Boolean)
    .distinctUntilChanged((prev, next) => prev.length === next.length)

  // Chronologically sorted feed of incoming and outgoing payments
  , feed$ = O.combineLatest(freshInvs$, freshPays$, (invoices, payments) => [
      ...invoices.map(i => [ 'in',  i.paid_at,    recvAmt(i), i ])
    , ...payments.map(p => [ 'out', p.created_at, p.msatoshi, p ])
    ].sort((a, b) => b[1] - a[1]))

  // Collapsed payment/invoice on home feed list
  , feedActive$ = togFeed$.merge( // display feed items manually toggled by the user, and...
      incoming$.map(inv => `in-${inv.payment_hash}`) // auto display incoming payments
    , outgoing$.map(pay => `out-${pay.payment_hash}`) // auto display outgoing payments
    , feedStart_$.mapTo(null) // reset on feed paging
    , goHome$.filter(p => p.search != '?r').mapTo(null) // reset on home navigation (unless auto-redirected)
    ).startWith(null).scan((S, fid) => S == fid ? null : fid) // clicking the visible feed item again toggles it off

  // Start index for home feed based on user page navigation + reset on home nav
  , feedStart$ = feedStart_$.merge(goHome$.mapTo(0))

  // Payment amount field handling (shared for creating new invoices and paying custom amounts)
  , amtMsat$ = amtVal$.withLatestFrom(rate$, (amt, rate) => amt && rate && big(amt).div(rate).toFixed(0) || '')
                      .merge(page$.mapTo(null)).startWith(null)
  , amtData$ = combine({
      msatoshi: amtMsat$
    , amount:   unit$.withLatestFrom(amtMsat$, rate$, (unit, msat, rate) => formatAmt(msat, rate, unitprec[unit], false))
                     .merge(goRecv$.merge(offer$).merge(payreq$).mapTo(''))
    , unit:     unit$
    , step:     unit$.map(unit => unitstep[unit])
    })

  // Collapsed channel
  , chanActive$ = O.merge(
      togChan$ // display channel toggler by the user
    , funded$.map(f => f.chan.channel_id) // auto display newly funded channels
    , goChan$.filter(p => p.search != '?r').mapTo(null) // reset when opening channels page
  ).startWith(null).scan((S, chanid) => S == chanid ? null : chanid)

  // Offers
  , offersEnabled$ = lnconfig$.map(checkOffersEnabled).startWith(null)
  , offerPayQuantity$ = offerPayQuantityInput$
      .merge(offer$.map(offer => offer.quantity_min))
      .startWith(null)

  // RPC console history
  , rpcHist$ = execRes$.startWith([]).merge(clrHist$.mapTo('clear'))
      .scan((xs, x) => x === 'clear' ? [] : [ x, ...xs ].slice(0, 20))

  dbg({ loading$, connected$, alert$, rpcHist$, freshPays$, freshInvs$, feed$, feedStart$, feedActive$ }, 'spark:model')
  dbg({ error$ }, 'spark:error')
  dbg({ savedConf$, conf$, expert$, theme$, unit$, conf$ }, 'spark:config')

  return combine({
    conf$, page$, loading$, alert$
  , unitf$, cbalance$, rate$
  , funds$: funds$.startWith(null), obalance$: obalance$.startWith(null)
  , info$: info$.startWith(null), peers$: peers$.startWith(null), channels$: channels$.startWith(null)
  , feed$: feed$.startWith(null), feedStart$, feedActive$
  , amtData$, chanActive$, rpcHist$
  , fundMaxChan$
  , offersEnabled$, offerPayQuantity$, invUseOffer$
  , msatusd$, btcusd$: btcusd$.startWith(null)
  }).shareReplay(1)
}

const unit_formatter = (unit, msatusd) => (msat, display_alt=false) => {
  const unit_rate = unitrate[unit] || msatusd
  let display_str = `${unit_rate ? formatAmt(msat, unit_rate, unitprec[unit]) : 'n/a'} ${unit}`

  if (display_alt) {
    const alt_unit = unit == 'USD' ? 'sat' : 'USD'
    if (alt_unit != 'USD' || msatusd) {
      display_str += ` (${unit_formatter(alt_unit, msatusd)(msat)})`
    }
  }

  return display_str
}

// Check if experimental offers support is enabled
// Always considered off in c-lightning <=v0.10.0 because it used an incompatible spec.
const checkOffersEnabled = conf =>
  !!(conf['experimental-offers'] && !/^0\.(9\.|10\.0)/.test(conf['# version']))