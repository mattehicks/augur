import speedomatic from 'speedomatic'
import { createBigNumber } from 'utils/create-big-number'
import { each } from 'async'
import { augur } from 'services/augurjs'
import { UNIVERSE_ID } from 'modules/app/constants/network'
import { updateMarketRepBalance, updateMarketFrozenSharesValue, updateMarketEscapeHatchGasCost, updateMarketTradingEscapeHatchGasCost, updateMarketEthBalance } from 'modules/markets/actions/update-markets-data'
import { loadAccountPositions } from 'modules/my-positions/actions/load-account-positions'
import noop from 'utils/noop'
import logError from 'utils/log-error'

export default function (ownedMarketIds, tradingMarketIds, callback = logError) {
  return (dispatch, getState) => {
    const { marketsData, universe } = getState()
    const universeID = universe.id || UNIVERSE_ID

    // Update all owned market REP balances
    augur.api.Universe.getReputationToken({ tx: { to: universeID } }, (err, reputationTokenAddress) => {
      if (err) return callback(err)
      each(ownedMarketIds, (marketId) => {
        doUpdateMarketRepBalance(marketsData[marketId], reputationTokenAddress, dispatch, callback)
      })
    })

    // Update all markets with their frozen shares value
    dispatch(loadAccountPositions({}, (err, accountPositions) => {
      if (err) return callback(err)
      each(accountPositions, (position) => {
        doUpdateShareFrozenValue(getState().marketsData[position.marketId], dispatch, callback)
      })
    }))
  }
}

function doUpdateMarketRepBalance(market, reputationTokenAddress, dispatch, callback) {
  augur.api.ReputationToken.balanceOf({
    tx: { to: reputationTokenAddress },
    _owner: market.id,
  }, (err, attoRepBalance) => {
    if (err) return callback(err)
    augur.rpc.eth.getBalance([market.id, 'latest'], (err, attoEtherBalance) => {
      if (err) return callback(err)
      const repBalance = createBigNumber(attoRepBalance)
      const ethBalance = createBigNumber(attoEtherBalance)
      if (!market.repBalance || market.repBalance !== repBalance) dispatch(updateMarketRepBalance(market.id, repBalance))
      if (!market.ethBalance || market.ethBalance !== ethBalance) dispatch(updateMarketEthBalance(market.id, ethBalance))
      if (repBalance > 0 || ethBalance > 0) {
        augur.api.Market.withdrawInEmergency({
          tx: { estimateGas: true, to: market.id },
          onSent: noop,
          onSuccess: (attoGasCost) => {
            const gasCost = speedomatic.encodeNumberAsJSNumber(attoGasCost)
            dispatch(updateMarketEscapeHatchGasCost(market.id, gasCost))
          },
          onFailed: callback,
        })
      }
    })
  })
}

function doUpdateShareFrozenValue(market, dispatch, callback) {
  augur.api.TradingEscapeHatch.getFrozenShareValueInMarket({
    tx: { send: false },
    _market: market.id,
  }, (err, attoEth) => {
    if (err) return callback(err)
    const frozenSharesValue = createBigNumber(attoEth)
    if (!market.frozenSharesValue || market.frozenSharesValue !== frozenSharesValue) {
      dispatch(updateMarketFrozenSharesValue(market.id, frozenSharesValue))
      if (frozenSharesValue > 0) {
        augur.api.TradingEscapeHatch.claimSharesInUpdate({
          tx: { estimateGas: true },
          _market: market.id,
          onSent: noop,
          onSuccess: (attoGasCost) => {
            const gasCost = speedomatic.unfix(attoGasCost, 'number')
            dispatch(updateMarketTradingEscapeHatchGasCost(market.id, gasCost))
          },
          onFailed: callback,
        })
      }
    }
  })
}
