import { MARKET_CREATION, TRANSFER, REPORTING, TRADE, OPEN_ORDER, BUY, SELL } from 'modules/transactions/constants/types'
import { SUCCESS, PENDING } from 'modules/transactions/constants/statuses'
import { updateTransactionsData } from 'modules/transactions/actions/update-transactions-data'
import { eachOf, each, groupBy } from 'async'
import { unfix } from 'speedomatic'
import { createBigNumber } from 'utils/create-big-number'
import { convertUnixToFormattedDate } from 'src/utils/format-date'
import { BINARY, CATEGORICAL } from 'modules/markets/constants/market-types'
import { formatShares } from 'utils/format-number'

function groupByMethod(values, prop) {
  let grouped = {}
  groupBy(values, (t, cb) => {
    cb(null, t[prop])
  }, (err, result) => {
    if (!err && result) {
      grouped = result
    }
  })
  return grouped
}

function formatTransactionMessage(sumBuy, sumSell, txType) {
  const buys = (sumBuy !== 0 ? `${sumBuy} ${BUY}` : '')
  const sells = (sumSell !== 0 ? `${sumSell} ${SELL}` : '')
  return buys + (sumBuy !== 0 && sumSell !== 0 ? ' & ' : ' ') + sells + ' ' + (sumBuy + sumSell > 1 ? txType + 's' : txType)
}

export function addTradeTransactions(trades) {
  return (dispatch, getState) => {
    const { marketsData } = getState()
    const transactions = {}
    const sorted = groupByMethod(trades, 'tradeGroupId')
    // todo: need fallback if groupBy fails and groups aren't created
    each(sorted, (group) => {
      if (group[0].tradeGroupId === undefined) {
        each(group, (trade) => {
          const header = buildTradeTransaction(trade, marketsData)
          transactions[header.hash] = header
        })
      } else {
        const header = buildTradeTransactionGroup(group, marketsData)
        transactions[header.hash] = header
      }
    })
    dispatch(updateTransactionsData(transactions))
  }
}

function buildTradeTransactionGroup(group, marketsData) {
  let header = {}
  let sumBuy = 0
  let sumSell = 0
  each(group, (trade) => {
    if (trade.type === BUY) {
      sumBuy += 1
    }
    if (trade.type === SELL) {
      sumSell += 1
    }
    const localHeader = buildTradeTransaction(trade, marketsData)
    if (Object.keys(header).length === 0) {
      header = localHeader
    } else {
      header.transactions.push(localHeader.transactions[0])
    }
  })

  header.message = formatTransactionMessage(sumBuy, sumSell, 'Trade')
  return header
}

function buildTradeTransaction(trade, marketsData) {
  const market = marketsData[trade.marketId]
  const transaction = { ...trade, market }
  transaction.status = SUCCESS
  transaction.id = `${transaction.transactionHash}-${transaction.orderId}`
  const header = buildHeader(transaction, TRADE)
  const meta = {}
  meta.type = TRADE
  const outcomeName = getOutcome(market, transaction.outcome)
  if (outcomeName) meta.outcome = outcomeName
  meta.price = transaction.price
  meta.fee = transaction.settlementFees
  transaction.meta = meta
  header.status = SUCCESS
  if (transaction.market) {
    header.description = transaction.market.description
  }
  const formattedShares = formatShares(transaction.numFillerTokens || transaction.amount)
  transaction.message = `${transaction.type || transaction.orderType} ${formattedShares.formatted} Shares @ ${transaction.price} ETH`
  header.transactions = [transaction]
  return header
}

export function addTransferTransactions(transfers) {
  return (dispatch, getState) => {
    const { blockchain } = getState()
    const transactions = {}
    each(transfers, (transfer) => {
      const transaction = { ...transfer }
      transaction.id = `${transaction.transactionHash}-${transaction.logIndex}`
      const header = buildHeader(transaction, TRANSFER, SUCCESS)
      header.transactions = [transaction]
      const meta = {}
      meta.txhash = transaction.transactionHash
      meta.recipient = transaction.recipient
      meta.sender = transaction.sender
      meta.confirmations = blockchain.currentBlockNumber - transaction.creationBlockNumber
      transaction.meta = meta
      header.message = 'Transfer'
      header.description = `${transaction.value} ${transaction.symbol} transferred from ${transaction.sender} to ${transaction.recipient}`
      transactions[transaction.id] = header
    })
    dispatch(updateTransactionsData(transactions))
  }
}

export function addNewMarketCreationTransactions(market) {
  return (dispatch, getState) => {
    const marketCreationData = {}
    const { loginAccount } = getState()
    const transaction = {
      timestamp: market._endTime,
      createdBy: loginAccount.address,
      id: market.hash,
    }
    const fee = unfix(market._feePerEthInWei, 'number')
    const percentage = createBigNumber(fee.toString()).times(createBigNumber(100)).toNumber()
    const meta = {
      txhash: market.hash,
      'designated reporter': market._designatedReporterAddress,
      'settlement fee': `${percentage} %`,
    }
    transaction.meta = meta

    const header = {
      ...buildHeader(transaction, MARKET_CREATION, PENDING),
      message: 'Market Creation',
      description: market._description,
      transactions: [transaction],
    }

    marketCreationData[transaction.id] = header
    dispatch(updateTransactionsData(marketCreationData))
  }
}

export function addMarketCreationTransactions(marketsCreated) {
  return (dispatch, getState) => {
    const marketCreationData = {}
    const { loginAccount, marketsData } = getState()
    each(marketsCreated, (marketId) => {
      const market = marketsData[marketId]
      const transaction = { marketId, market }
      transaction.timestamp = transaction.creationTime
      transaction.createdBy = loginAccount.address
      transaction.id = marketId
      transaction.timestamp = (market || {}).creationTime
      const meta = {}
      meta.market = transaction.marketId
      meta['creation fee'] = market.creationFee
      meta['market type'] = market.marketType
      transaction.meta = meta
      const header = buildHeader(transaction, MARKET_CREATION, SUCCESS)
      header.message = 'Market Creation'
      if (transaction.market !== undefined) {
        header.description = market.description
      }
      header.transactions = [transaction]
      marketCreationData[transaction.id] = header
    })
    dispatch(updateTransactionsData(marketCreationData))
  }
}

export function addOpenOrderTransactions(openOrders) {
  return (dispatch, getState) => {
    const { marketsData } = getState()
    // flatten open orders
    const transactions = {}
    let index = 100
    eachOf(openOrders, (value, marketId) => {
      const market = marketsData[marketId]
      // TODO: remove index when I figure a comprehensive uique id strategy
      index += 1
      let sumBuy = 0
      let sumSell = 0
      const marketHeader = {}
      marketHeader.status = 'Market Outcome Trade'
      marketHeader.hash = marketId + index
      if (market !== undefined) {
        marketHeader.description = market.description
      }
      marketHeader.sortOrder = getSortOrder(OPEN_ORDER)
      marketHeader.id = marketHeader.hash
      let creationTime = null
      const marketTradeTransactions = []
      eachOf(value, (value2, outcome) => {
        eachOf(value2, (value3, type) => {
          eachOf(value3, (value4, hash) => {
            const transaction = { marketId, type, hash, ...value4 }
            transaction.id = transaction.transactionHash + transaction.logIndex
            transaction.message = `${transaction.orderState} - ${type} ${transaction.fullPrecisionAmount} Shares @ ${transaction.fullPrecisionPrice} ETH`
            const meta = {}
            creationTime = convertUnixToFormattedDate(transaction.creationTime)
            meta.txhash = transaction.transactionHash
            meta.timestamp = creationTime.full
            const outcomeName = getOutcome(market, outcome)
            if (outcomeName) meta.outcome = outcomeName
            meta.status = transaction.orderState
            meta.amount = transaction.fullPrecisionAmount
            meta.price = transaction.fullPrecisionPrice
            transaction.meta = meta
            marketTradeTransactions.push(transaction)
            if (type === BUY) {
              sumBuy += 1
            }
            if (type === SELL) {
              sumSell += 1
            }
          })
        })
      })
      // TODO: last order creation time will be in header, eariest activite
      marketHeader.timestamp = creationTime
      marketHeader.message = formatTransactionMessage(sumBuy, sumSell, 'Order')
      marketHeader.transactions = marketTradeTransactions
      transactions[marketHeader.id] = marketHeader
    })
    dispatch(updateTransactionsData(transactions))
  }
}

export function addReportingTransactions(reports) {
  return (dispatch, getState) => {
    const { marketsData } = getState()
    const transactions = {}
    eachOf(reports, (value, universe) => {
      eachOf(value, (value1, marketId) => {
        eachOf(value1, (report, index) => {
          const market = marketsData[marketId]
          const transaction = {
            universe, marketId, ...report, market,
          }
          transaction.id = transaction.transactionHash + transaction.logIndex
          const meta = {}
          meta.txhash = transaction.transactionHash
          meta.marketId = transaction.marketId
          meta.staked = `${transaction.amountStaked} REP`
          meta.numerators = JSON.stringify(transaction.payoutNumerators)
          transaction.meta = meta
          transaction.timestamp = transaction.creationTime
          const header = buildHeader(transaction, REPORTING, SUCCESS)
          header.transactions = [transaction]
          header.message = 'Market Reporting'
          header.description = `Staked  ${transaction.amountStaked} REP on market ${market.description}`
          // create unique id
          transactions[transaction.id] = header
        })
      })
    })
    dispatch(updateTransactionsData(transactions))
  }
}

function getOutcome(market, outcome) {
  let value = null
  if (!market || !outcome) return value
  if (market.marketType === BINARY) {
    value = 'Yes'
  } else if (market.marketType === CATEGORICAL) {
    value = market.outcomes[outcome].description
  }
  return value
}
function buildHeader(item, type, status) {
  const header = {}
  header.status = status
  header.hash = item.id
  // TODO: need to sort by datetime in render
  header.timestamp = convertUnixToFormattedDate(item.timestamp ? item.timestamp : item.creationTime)
  header.sortOrder = getSortOrder(type)
  return header
}

// TODO: this should be dynamic by user control
function getSortOrder(type) {
  if (type === OPEN_ORDER) {
    return 10
  }
  if (type === TRADE) {
    return 20
  }
  if (type === TRANSFER) {
    return 50
  }
  if (type === MARKET_CREATION) {
    return 90
  }
  if (type === REPORTING) {
    return 100
  }
  return 1000
}
