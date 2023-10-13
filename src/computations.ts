import {
  SubAccountDetails,
  SubAccountComputed,
  SubAccount,
  Asset,
  PriceDict,
  cloneSubAccount,
  OpenPositionResult,
  ClosePositionResult,
  WithdrawProfitResult,
  LiquidityPool,
  InsufficientLiquidityError,
  InvalidArgumentError,
  BugError,
  WithdrawCollateralResult,
  InsufficientLiquidityType
} from './types'
import { SpreadType, _0, _1 } from './constants'
import { decodeSubAccountId } from './data'
import BigNumber from 'bignumber.js'

export function computeSubAccount(
  assets: Asset[],
  subAccountId: string,
  subAccount: SubAccount,
  collateralPrice: BigNumber,
  assetPrice: BigNumber
): SubAccountDetails {
  const { collateralId, assetId, isLong } = decodeSubAccountId(subAccountId)
  const positionValueUsd = assetPrice.times(subAccount.size)
  const fundingFeeUsd = computeFundingFeeUsd(subAccount, assets[assetId], isLong, assetPrice)
  const { pendingPnlUsd, pnlUsd } = computePositionPnlUsd(
    assets[assetId],
    subAccount,
    isLong,
    subAccount.size,
    assetPrice
  )
  const pendingPnlAfterFundingUsd = pendingPnlUsd.minus(fundingFeeUsd)
  const pnlAfterFundingUsd = pnlUsd.minus(fundingFeeUsd)
  const collateralValue = subAccount.collateral.times(collateralPrice)
  const marginBalanceUsd = collateralValue.plus(pendingPnlAfterFundingUsd)
  const isIMSafe = marginBalanceUsd.gte(positionValueUsd.times(assets[assetId].initialMarginRate))
  const isMMSafe = marginBalanceUsd.gte(positionValueUsd.times(assets[assetId].maintenanceMarginRate))
  const isMarginSafe = marginBalanceUsd.gte(_0)
  const leverage = collateralValue.gt(0) ? subAccount.entryPrice.times(subAccount.size).div(collateralValue) : _0
  const effectiveLeverage = marginBalanceUsd.gt(0) ? positionValueUsd.div(marginBalanceUsd) : _0
  let pendingRoe = collateralValue.gt(0) ? pendingPnlAfterFundingUsd.div(collateralValue) : _0
  const liquidationPrice = _estimateLiquidationPrice(
    assets,
    collateralId,
    assetId,
    isLong,
    subAccount,
    collateralPrice,
    fundingFeeUsd
  )
  // withdraw collateral
  const safeImr = BigNumber.maximum(assets[assetId].initialMarginRate, '0.01') // limit to 100x in the next calculation
  let withdrawableCollateral = BigNumber.min(
    collateralValue.plus(pnlAfterFundingUsd).minus(positionValueUsd.times(safeImr)), // IM
    collateralValue.minus(fundingFeeUsd).minus(subAccount.entryPrice.times(subAccount.size).times(safeImr)) // leverage
  )
  withdrawableCollateral = BigNumber.max(_0, withdrawableCollateral)
  withdrawableCollateral = withdrawableCollateral.div(collateralPrice)
  // withdraw profit
  let withdrawableProfit = BigNumber.min(
    collateralValue.plus(pnlAfterFundingUsd).minus(positionValueUsd.times(safeImr)), // IM
    pnlAfterFundingUsd // profit
  )
  withdrawableProfit = BigNumber.max(_0, withdrawableProfit)
  if (isLong) {
    withdrawableProfit = withdrawableProfit.div(assetPrice)
  }
  const computed: SubAccountComputed = {
    positionValueUsd,
    fundingFeeUsd,
    pendingPnlUsd,
    pendingPnlAfterFundingUsd,
    pnlUsd,
    marginBalanceUsd,
    isIMSafe,
    isMMSafe,
    isMarginSafe,
    leverage,
    effectiveLeverage,
    pendingRoe,
    liquidationPrice,
    withdrawableCollateral,
    withdrawableProfit
  }
  return { subAccount, computed }
}

// get price with spread when open/close positions
export function computeTradingPrice(
  assets: Asset[],
  subAccountId: string,
  prices: PriceDict, // given by off-chain broker
  isOpenPosition: boolean // true if openPosition
): { assetPrice: BigNumber; collateralPrice: BigNumber } {
  const { collateralId, assetId, isLong } = decodeSubAccountId(subAccountId)
  if (collateralId >= assets.length) {
    throw new InvalidArgumentError(`missing asset[${collateralId}]`)
  }
  if (assetId >= assets.length) {
    throw new InvalidArgumentError(`missing asset[${assetId}]`)
  }
  let collateralPrice = prices[assets[collateralId].symbol]
  let assetPrice = prices[assets[assetId].symbol]
  if (!collateralPrice || collateralPrice.lte(_0)) {
    throw new InvalidArgumentError(`invalid price[${assets[collateralId].symbol}]`)
  }
  if (!assetPrice || assetPrice.lte(_0)) {
    throw new InvalidArgumentError(`invalid price[${assets[assetId].symbol}]`)
  }
  let spreadType: SpreadType
  if (isOpenPosition) {
    spreadType = isLong ? SpreadType.Ask : SpreadType.Bid
  } else {
    spreadType = isLong ? SpreadType.Bid : SpreadType.Ask
  }
  assetPrice = computePriceWithSpread(assets[assetId], assetPrice, spreadType)
  return { assetPrice, collateralPrice }
}

// get price with spread when add/remove liquidity
export function computeLiquidityPrice(
  assets: Asset[],
  prices: PriceDict, // given by off-chain broker
  tokenId: number,
  isAddLiquidity: boolean // true if addLiquidity
): BigNumber {
  if (tokenId >= assets.length) {
    throw new InvalidArgumentError(`missing asset[${tokenId}]`)
  }
  let collateralPrice = prices[assets[tokenId].symbol]
  if (!collateralPrice || collateralPrice.lte(_0)) {
    throw new InvalidArgumentError(`invalid price[${assets[tokenId].symbol}]`)
  }
  let spreadType = isAddLiquidity ? SpreadType.Bid : SpreadType.Ask
  collateralPrice = computePriceWithSpread(assets[tokenId], collateralPrice, spreadType)
  return collateralPrice
}

export function computePositionPnlUsd(
  asset: Asset,
  subAccount: SubAccount,
  isLong: boolean,
  amount: BigNumber,
  assetPrice: BigNumber
): { pendingPnlUsd: BigNumber; pnlUsd: BigNumber } {
  if (amount.eq(_0)) {
    return { pendingPnlUsd: _0, pnlUsd: _0 }
  }
  let priceDelta = isLong ? assetPrice.minus(subAccount.entryPrice) : subAccount.entryPrice.minus(assetPrice)
  let pendingPnlUsd = priceDelta.times(amount)
  if (
    priceDelta.gt(_0) &&
    Math.ceil(Date.now() / 1000) < subAccount.lastIncreasedTime + asset.minProfitTime &&
    priceDelta.abs().lt(asset.minProfitRate.times(subAccount.entryPrice))
  ) {
    return { pendingPnlUsd, pnlUsd: _0 }
  }
  return { pendingPnlUsd, pnlUsd: pendingPnlUsd }
}

function _computeFeeUsd(
  subAccount: SubAccount,
  asset: Asset,
  isLong: boolean,
  amount: BigNumber,
  assetPrice: BigNumber
): BigNumber {
  let fee = computeFundingFeeUsd(subAccount, asset, isLong, assetPrice)
  fee = fee.plus(_computePositionFeeUsd(asset, amount, assetPrice))
  return fee
}

export function computeFundingFeeUsd(
  subAccount: SubAccount,
  asset: Asset,
  isLong: boolean,
  assetPrice: BigNumber
): BigNumber {
  if (subAccount.size.eq(_0)) {
    return _0
  }
  let cumulativeFunding = _0
  if (isLong) {
    cumulativeFunding = asset.longCumulativeFundingRate.minus(subAccount.entryFunding)
    cumulativeFunding = cumulativeFunding.times(assetPrice)
  } else {
    cumulativeFunding = asset.shortCumulativeFunding.minus(subAccount.entryFunding)
  }
  return cumulativeFunding.times(subAccount.size)
}

function _computePositionFeeUsd(asset: Asset, amount: BigNumber, assetPrice: BigNumber): BigNumber {
  if (amount.eq(_0)) {
    return _0
  }
  let feeUsd = assetPrice.times(asset.positionFeeRate).times(amount)
  return feeUsd
}

// note: mutable modify
function _updateEntryFunding(subAccount: SubAccount, asset: Asset, isLong: boolean) {
  if (isLong) {
    subAccount.entryFunding = asset.longCumulativeFundingRate
  } else {
    subAccount.entryFunding = asset.shortCumulativeFunding
  }
}

function _estimateLiquidationPrice(
  assets: Asset[],
  collateralId: number,
  assetId: number,
  isLong: boolean,
  subAccount: SubAccount,
  collateralPrice: BigNumber,
  fundingFeeUsd: BigNumber
): BigNumber {
  if (subAccount.size.eq(_0)) {
    return _0
  }
  const { maintenanceMarginRate } = assets[assetId]
  const longFactor = isLong ? _1 : _1.negated()
  const t = longFactor
    .minus(maintenanceMarginRate)
    .times(subAccount.size)
  let p = _0
  if (collateralId === assetId) {
    p = longFactor.times(subAccount.entryPrice).times(subAccount.size)
    p = p.plus(fundingFeeUsd).div(t.plus(subAccount.collateral))
    p = BigNumber.max(_0, p)
  } else {
    p = longFactor.times(subAccount.entryPrice).times(subAccount.size)
    p = p.plus(fundingFeeUsd).minus(collateralPrice.times(subAccount.collateral))
    p = p.div(t)
    p = BigNumber.max(_0, p)
  }

  // the liquidation price above is a tradingPrice, not indexPrice
  // * liquidate  long position: liquidateIndexPrice > tradingPrice (because close long means sell)
  // * liquidate short position: liquidateIndexPrice < tradingPrice
  if (isLong) {
    p = p.div(_1.minus(assets[assetId].halfSpread))
  } else {
    p = p.div(_1.plus(assets[assetId].halfSpread))
  }

  return p
}

export function computeOpenPosition(
  assets: Asset[],
  subAccountId: string,
  subAccount: SubAccount,
  prices: PriceDict,
  amount: BigNumber,
  brokerGasFee: BigNumber // in collateral. you can pass _0 when calling placePositionOrder
): OpenPositionResult {
  // context
  subAccount = cloneSubAccount(subAccount)
  const { collateralId, assetId, isLong } = decodeSubAccountId(subAccountId)
  const { collateralPrice, assetPrice } = computeTradingPrice(assets, subAccountId, prices, true)
  if (amount.lte(_0)) {
    throw new InvalidArgumentError(`invalid amount ${amount.toFixed()}`)
  }
  if (brokerGasFee.lt(_0)) {
    throw new InvalidArgumentError(`invalid gasFee ${brokerGasFee.toFixed()}`)
  }
  // protection
  if (
    assets[assetId].isStable ||
    !assets[assetId].isTradable ||
    !assets[assetId].isOpenable ||
    !assets[assetId].isEnabled ||
    !assets[collateralId].isEnabled ||
    (!isLong && !assets[assetId].isShortable)
  ) {
    throw new InvalidArgumentError('not tradable')
  }

  // fee & funding
  const fundingFeeUsd = computeFundingFeeUsd(subAccount, assets[assetId], isLong, assetPrice)
  const feeUsd = _computeFeeUsd(subAccount, assets[assetId], isLong, amount, assetPrice)
  _updateEntryFunding(subAccount, assets[assetId], isLong)
  let feeCollateral = feeUsd.div(collateralPrice)
  feeCollateral = feeCollateral.plus(brokerGasFee)
  if (subAccount.collateral.lt(feeCollateral)) {
    // InsufficientCollateralForFee. we continue in bitoro.js
  }
  subAccount.collateral = subAccount.collateral.minus(feeCollateral)
  // position
  const pnlUsd = computePositionPnlUsd(assets[assetId], subAccount, isLong, amount, assetPrice)
  const newSize = subAccount.size.plus(amount)
  if (pnlUsd.pnlUsd.eq(_0)) {
    subAccount.entryPrice = assetPrice
  } else {
    subAccount.entryPrice = subAccount.entryPrice
      .times(subAccount.size)
      .plus(assetPrice.times(amount))
      .div(newSize)
  }
  subAccount.size = newSize
  subAccount.lastIncreasedTime = Math.ceil(Date.now() / 1000)
  // post check
  const afterTrade = computeSubAccount(assets, subAccountId, subAccount, collateralPrice, assetPrice)
  return {
    afterTrade,
    isTradeSafe: afterTrade.computed.isIMSafe,
    fundingFeeUsd,
    feeUsd
  }
}

export function computeClosePosition(
  assets: Asset[],
  subAccountId: string,
  subAccount: SubAccount,
  profitAssetId: number,
  prices: PriceDict,
  amount: BigNumber,
  brokerGasFee: BigNumber // in collateral. you can pass _0 when calling placePositionOrder
): ClosePositionResult {
  // context
  subAccount = cloneSubAccount(subAccount)
  const { collateralId, assetId, isLong } = decodeSubAccountId(subAccountId)
  const { collateralPrice, assetPrice } = computeTradingPrice(assets, subAccountId, prices, false)
  let profitAssetPrice = _0
  if (isLong && !assets[assetId].useStableTokenForProfit) {
    profitAssetId = assetId
    profitAssetPrice = assetPrice
  } else {
    if (profitAssetId >= assets.length) {
      throw new InvalidArgumentError(`missing asset[${profitAssetId}]`)
    }
    if (!assets[profitAssetId].isStable) {
      throw new InvalidArgumentError(`profit asset[${profitAssetId}] should be a stable coin`)
    }
    profitAssetPrice = prices[assets[profitAssetId].symbol]
    if (!profitAssetPrice || profitAssetPrice.lte(_0)) {
      throw new InvalidArgumentError(`invalid price[${assets[profitAssetId].symbol}]`)
    }
  }
  if (amount.lte(_0) || amount.gt(subAccount.size)) {
    throw new InvalidArgumentError(`invalid amount ${amount.toFixed()}`)
  }
  if (brokerGasFee.lt(_0)) {
    throw new InvalidArgumentError(`invalid gasFee ${brokerGasFee.toFixed()}`)
  }
  // protection
  if (
    assets[assetId].isStable ||
    !assets[assetId].isTradable ||
    !assets[assetId].isEnabled ||
    !assets[collateralId].isEnabled ||
    (!isLong && !assets[assetId].isShortable)
  ) {
    throw new InvalidArgumentError('not tradable')
  }
  // fee & funding
  const totalFeeUsd = _computeFeeUsd(subAccount, assets[assetId], isLong, amount, assetPrice)
  _updateEntryFunding(subAccount, assets[assetId], isLong)
  // realize pnl
  let paidFeeUsd = _0
  let profitAssetTransferred = _0
  let bitoroTokenTransferred = _0
  const { pnlUsd } = computePositionPnlUsd(assets[assetId], subAccount, isLong, amount, assetPrice)
  if (pnlUsd.gt(_0)) {
    const result = computeRealizeProfit(pnlUsd, totalFeeUsd, assets[profitAssetId], profitAssetPrice)
    paidFeeUsd = result.deductUsd
    profitAssetTransferred = result.profitAssetTransferred
    bitoroTokenTransferred = result.bitoroTokenTransferred
  } else if (pnlUsd.lt(_0)) {
    computeRealizeLoss(subAccount, collateralPrice, pnlUsd.negated(), true)
  }
  subAccount.size = subAccount.size.minus(amount)
  if (subAccount.size.eq(_0)) {
    subAccount.entryPrice = _0
    subAccount.entryFunding = _0
    subAccount.lastIncreasedTime = 0
  }
  // ignore fees if can not afford
  if (brokerGasFee.gt(_0) || totalFeeUsd.gt(paidFeeUsd)) {
    let feeCollateral = totalFeeUsd.minus(paidFeeUsd).div(collateralPrice)
    let feeAndGasCollateral = feeCollateral.plus(brokerGasFee)
    if (subAccount.collateral.lt(feeAndGasCollateral)) {
      feeAndGasCollateral = subAccount.collateral
      if (subAccount.collateral.lt(brokerGasFee)) {
        feeCollateral = _0
      } else {
        feeCollateral = subAccount.collateral.minus(brokerGasFee)
      }
    }
    subAccount.collateral = subAccount.collateral.minus(feeAndGasCollateral)
    paidFeeUsd = paidFeeUsd.plus(feeCollateral.times(collateralPrice))
  }
  // post check
  const afterTrade = computeSubAccount(assets, subAccountId, subAccount, collateralPrice, assetPrice)
  return {
    afterTrade,
    isTradeSafe: afterTrade.computed.isMarginSafe,
    feeUsd: paidFeeUsd,
    profitAssetTransferred,
    bitoroTokenTransferred
  }
}

export function computeWithdrawCollateral(
  assets: Asset[],
  subAccountId: string,
  subAccount: SubAccount,
  prices: PriceDict,
  amount: BigNumber
): WithdrawCollateralResult {
  // context
  subAccount = cloneSubAccount(subAccount)
  const { collateralId, assetId, isLong } = decodeSubAccountId(subAccountId)
  const { collateralPrice, assetPrice } = computeTradingPrice(assets, subAccountId, prices, false /* isOpen */)
  if (amount.lte(_0)) {
    throw new InvalidArgumentError(`invalid amount ${amount.toFixed()}`)
  }
  // protection
  if (!assets[assetId].isEnabled || !assets[collateralId].isEnabled) {
    throw new InvalidArgumentError('not tradable')
  }
  // fee & funding
  const totalFeeUsd = computeFundingFeeUsd(subAccount, assets[assetId], isLong, assetPrice)
  if (subAccount.size.gt(_0)) {
    _updateEntryFunding(subAccount, assets[assetId], isLong)
  }
  const feeCollateral = totalFeeUsd.div(collateralPrice)
  subAccount.collateral = subAccount.collateral.minus(feeCollateral)
  // withdraw
  subAccount.collateral = subAccount.collateral.minus(amount)
  // post check
  const afterTrade = computeSubAccount(assets, subAccountId, subAccount, collateralPrice, assetPrice)
  return {
    afterTrade,
    isTradeSafe: afterTrade.computed.isIMSafe,
    feeUsd: totalFeeUsd
  }
}

export function computeWithdrawProfit(
  assets: Asset[],
  subAccountId: string,
  subAccount: SubAccount,
  profitAssetId: number,
  prices: PriceDict,
  amount: BigNumber
): WithdrawProfitResult {
  // context
  subAccount = cloneSubAccount(subAccount)
  const { collateralId, assetId, isLong } = decodeSubAccountId(subAccountId)
  const { collateralPrice, assetPrice } = computeTradingPrice(assets, subAccountId, prices, false /* isOpen */)
  let profitAssetPrice = _0
  if (isLong && !assets[assetId].useStableTokenForProfit) {
    profitAssetId = assetId
    profitAssetPrice = assetPrice
  } else {
    if (profitAssetId >= assets.length) {
      throw new InvalidArgumentError(`missing asset[${profitAssetId}]`)
    }
    if (!assets[profitAssetId].isStable) {
      throw new InvalidArgumentError(`profit asset[${profitAssetId}] should be a stable coin`)
    }
    profitAssetPrice = prices[assets[profitAssetId].symbol]
    if (!profitAssetPrice || profitAssetPrice.lte(_0)) {
      throw new InvalidArgumentError(`invalid price[${assets[profitAssetId].symbol}]`)
    }
  }
  if (amount.lte(_0)) {
    throw new InvalidArgumentError(`invalid amount ${amount.toFixed()}`)
  }
  // protection
  if (
    assets[assetId].isStable ||
    !assets[assetId].isTradable ||
    !assets[assetId].isEnabled ||
    !assets[collateralId].isEnabled ||
    (!isLong && !assets[assetId].isShortable)
  ) {
    throw new InvalidArgumentError('not tradable')
  }
  if (subAccount.size.eq(_0)) {
    throw new InvalidArgumentError('empty position')
  }
  // fee & funding
  const totalFeeUsd = computeFundingFeeUsd(subAccount, assets[assetId], isLong, assetPrice)
  _updateEntryFunding(subAccount, assets[assetId], isLong)
  // withdraw
  const deltaUsd = amount.times(profitAssetPrice).plus(totalFeeUsd)
  // profit
  const { pnlUsd } = computePositionPnlUsd(assets[assetId], subAccount, isLong, subAccount.size, assetPrice)
  if (pnlUsd.lt(deltaUsd)) {
    throw new Error('insufficient pnl')
  }
  const { profitAssetTransferred, bitoroTokenTransferred } = computeRealizeProfit(
    pnlUsd,
    totalFeeUsd,
    assets[profitAssetId],
    profitAssetPrice
  )
  // new entry price
  if (isLong) {
    subAccount.entryPrice = subAccount.entryPrice.plus(deltaUsd.div(subAccount.size))
  } else {
    subAccount.entryPrice = subAccount.entryPrice.minus(deltaUsd.div(subAccount.size))
  }
  // post check
  const afterTrade = computeSubAccount(assets, subAccountId, subAccount, collateralPrice, assetPrice)
  return {
    afterTrade,
    isTradeSafe: afterTrade.computed.isIMSafe,
    feeUsd: totalFeeUsd,
    profitAssetTransferred,
    bitoroTokenTransferred
  }
}

export function computeRealizeProfit(
  profitUsd: BigNumber,
  feeUsd: BigNumber,
  profitAsset: Asset,
  profitAssetPrice: BigNumber
): { deductUsd: BigNumber; profitAssetTransferred: BigNumber; bitoroTokenTransferred: BigNumber } {
  let deductUsd = BigNumber.minimum(profitUsd, feeUsd)
  let profitAssetTransferred = _0
  let bitoroTokenTransferred = _0
  // pnl
  profitUsd = profitUsd.minus(deductUsd)
  if (profitUsd.gt(_0)) {
    let profitCollateral = profitUsd.div(profitAssetPrice)
    // transfer profit token
    let spot = BigNumber.minimum(profitCollateral, profitAsset.spotLiquidity)
    if (spot.gt(_0)) {
      profitAssetTransferred = spot
    }
    // debt
    const debtWadAmount = profitCollateral.minus(spot)
    if (debtWadAmount.gt(_0)) {
      bitoroTokenTransferred = debtWadAmount
    }
  }
  return { deductUsd, profitAssetTransferred, bitoroTokenTransferred }
}

export function computeRealizeLoss(
  subAccount: SubAccount,
  collateralPrice: BigNumber,
  lossUsd: BigNumber,
  isThrowBankrupt: boolean
) {
  if (lossUsd.eq(_0)) {
    return
  }
  let lossCollateral = lossUsd.div(collateralPrice)
  if (isThrowBankrupt) {
    if (subAccount.collateral.lt(lossCollateral)) {
      throw new Error('bankrupt')
    }
  } else {
    lossCollateral = BigNumber.minimum(lossCollateral, subAccount.collateral)
  }
  subAccount.collateral = subAccount.collateral.minus(lossCollateral)
}

export function computeLiquidityFeeRate(
  poolConfig: LiquidityPool,
  currentAssetValue: BigNumber,
  targetAssetValue: BigNumber,
  isAdd: boolean,
  deltaValue: BigNumber
): BigNumber {
  const baseFeeRate = poolConfig.liquidityBaseFeeRate
  const dynamicFeeRate = poolConfig.liquidityDynamicFeeRate
  let newAssetValue = _0
  if (isAdd) {
    newAssetValue = currentAssetValue.plus(deltaValue)
  } else {
    if (currentAssetValue.lt(deltaValue)) {
      throw new InsufficientLiquidityError(
        InsufficientLiquidityType.BitoroRemoveLiquidityExceedsCurrentAsset,
        `removed value ${deltaValue} > liquidity ${currentAssetValue}`
      )
    }
    newAssetValue = currentAssetValue.minus(deltaValue)
  }
  // | x - target |
  const oldDiff = currentAssetValue.minus(targetAssetValue).abs()
  const newDiff = newAssetValue.minus(targetAssetValue).abs()
  if (targetAssetValue.eq(_0)) {
    // avoid division by 0
    return baseFeeRate
  } else if (newDiff.lt(oldDiff)) {
    // improves
    const rebate = dynamicFeeRate
      .times(oldDiff)
      .div(targetAssetValue)
      .dp(5, BigNumber.ROUND_DOWN)
    return BigNumber.maximum(_0, baseFeeRate.minus(rebate))
  } else {
    // worsen
    let avgDiff = oldDiff.plus(newDiff).div(2)
    avgDiff = BigNumber.minimum(avgDiff, targetAssetValue)
    const dynamic = dynamicFeeRate
      .times(avgDiff)
      .div(targetAssetValue)
      .dp(5, BigNumber.ROUND_DOWN)
    return baseFeeRate.plus(dynamic)
  }
}

// NOTE: this function always returns 8h funding rate. if fundingInterval is 1h, the fee will be
//       fundingRate8H / 8 every hour.
export function computeFundingRate8H(
  pool: LiquidityPool,
  asset: Asset,
  stableUtilization: BigNumber,
  unstableUtilization: BigNumber
): { longFundingRate8H: BigNumber; shortFundingRate8H: BigNumber } {
  const shortFundingRate8H = computeSingleFundingRate8H(
    pool.shortFundingBaseRate8H,
    pool.shortFundingLimitRate8H,
    stableUtilization
  )
  const longFundingRate8H = computeSingleFundingRate8H(
    asset.longFundingBaseRate8H,
    asset.longFundingLimitRate8H,
    unstableUtilization
  )
  return { longFundingRate8H, shortFundingRate8H }
}

/**
 * Funding rate formula
 *
 * ^ fr           / limit
 * |            /
 * |          /
 * |        /
 * |______/ base
 * |    .
 * |  .
 * |.
 * +-------------------> %util
 *
 * NOTE: this function always returns 8h funding rate. if fundingInterval is 1h, the fee will be
 *       fundingRate8H / 8 every hour.
 */
export function computeSingleFundingRate8H(
  baseRate8H: BigNumber,
  limitRate8H: BigNumber,
  utilization: BigNumber
): BigNumber {
  if (utilization.gt(_1)) {
    throw new InvalidArgumentError('%utilization > 100%')
  }
  let fundingRate8H = utilization.times(limitRate8H)
  fundingRate8H = BigNumber.maximum(fundingRate8H, baseRate8H)
  return fundingRate8H
}

/**
 * @dev check price and add spread, where spreadType should be:
 *
 *      subAccount.isLong   openPosition   closePosition   addLiquidity   removeLiquidity
 *      long                ask            bid
 *      short               bid            ask
 *      N/A                                                bid            ask
 */
export function computePriceWithSpread(asset: Asset, price: BigNumber, spreadType: SpreadType): BigNumber {
  if (asset.halfSpread.eq(_0)) {
    return price
  }
  const halfSpread = price.times(asset.halfSpread)
  if (spreadType == SpreadType.Bid) {
    if (price.lte(halfSpread)) {
      throw new BugError(`price - halfSpread = 0. impossible. price: ${price.toFixed()}`)
    }
    return price.minus(halfSpread)
  } else {
    return price.plus(halfSpread)
  }
}
