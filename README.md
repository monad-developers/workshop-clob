# Onchain CLOB on Monad

A central limit order book written from scratch in one Solidity contract, with a Foundry test suite and a Next.js trading UI, that you can deploy and run on Monad.

The order book lives in [`packages/foundry/contracts/CLOB.sol`](packages/foundry/contracts/CLOB.sol). It is about 300 lines: two price-sorted singly linked lists (bids and asks), a matching loop that walks the opposite side of the book, and immediate ERC20 settlement on every fill. Two mock tokens, [`BTC.sol`](packages/foundry/contracts/BTC.sol) and [`USDC.sol`](packages/foundry/contracts/USDC.sol), are included so you have something to trade.

This is a reference implementation built for a workshop. It is meant to be read, stepped through, and deployed to a testnet so you can watch orders rest, match, and cancel onchain. It has not been audited and has known correctness gaps (listed under [Limitations](#limitations-and-known-issues)). Do not put real funds behind it.

The project is scaffolded with [Scaffold-ETH 2](https://docs.scaffoldeth.io) (Foundry, Next.js, wagmi, viem, RainbowKit). Source comments in the contracts, tests, and UI are in Chinese.

## Repository layout

```
packages/foundry/
  contracts/CLOB.sol          the order book
  contracts/BTC.sol           mock ERC20, 18 decimals, open mint()
  contracts/USDC.sol          mock ERC20, 18 decimals, open mint()
  test/CLOB.t.sol             Foundry tests (5 tests)
  script/DeployYourContract.s.sol   deploys BTC, USDC, CLOB and mints test balances
  foundry.toml                RPC endpoints (Monad testnet is preconfigured)
packages/nextjs/
  app/trade/                  order form, order book, trade history
  app/debug/                  Scaffold-ETH contract debugger
  scaffold.config.ts          target network for the frontend
```

## How the order book works

### The pair and the price

The constructor takes two ERC20 addresses and stores them as `token0` and `token1` (both `immutable`). The contract never renames them, so the rest of this section uses those names.

- A **bid** locks `token0` and receives `token1`.
- An **ask** locks `token1` and receives `token0`.
- `price` is the amount of `token0` per one whole `token1`, as an 18-decimal fixed-point number. `2e18` means two `token0` per `token1`.

The `amount` argument to `placeOrder` is denominated in whichever token the order locks: `token0` for a bid, `token1` for an ask. The contract pulls exactly `amount` from the caller with `transferFrom`, so the caller must `approve` the CLOB first.

The deploy script wires BTC in as `token0` and USDC as `token1`. That means a "bid" in this deployment spends BTC to buy USDC, and the price is BTC per USDC. The trade UI follows the same convention: its buy form asks you to approve BTC, its sell form asks you to approve USDC. Keep this in mind when reading balances.

### Storage

```solidity
struct Order {
    address owner;
    uint256 price;
    uint256 amount;   // remaining, in the locked token
    uint128 next;     // next order id in the same list, 0 = end
    bool    isBid;
}

mapping(uint128 => Order) public orders;
uint128 public orderCount;   // last assigned id; ids start at 1
uint128 public bidHead;      // best bid, 0 if empty
uint128 public askHead;      // best ask, 0 if empty
```

Each side of the book is a singly linked list threaded through `orders` by the `next` field. Bids are kept from highest price to lowest, asks from lowest to highest, so the head of each list is always the best price. There is no separate "active" flag: an order is live if and only if it is reachable from `bidHead` or `askHead`. Filled and cancelled orders are unlinked but not deleted, so `orders(id)` still returns their last state.

### Placing an order

`placeOrder(price, amount, isBid)`:

1. Reverts with `InvalidPriceOrAmount` if either value is zero.
2. Pulls `amount` of the locked token from `msg.sender` into the contract. A `false` return reverts with `TransferFailed`.
3. Calls `_matchOrders`, which walks the opposite side starting at its head and fills against each resting order while the price crosses:
   - a bid keeps matching while `ask.price <= price`;
   - an ask keeps matching while `bid.price >= price`.
   Because the lists are sorted, the loop stops at the first order that does not cross.
4. Every fill executes at the **resting order's price**, not the taker's limit. For a bid, the fill size is `min(remainingToken0 * 1e18 / ask.price, ask.amount)` units of `token1`, and the bid's remaining `token0` is reduced by `fill * ask.price / 1e18`. For an ask, the fill size is `min(remainingToken1, bid.amount)`.
5. Each fill settles immediately from the contract's own balances: `token1` goes to the buyer and `fill * price / 1e18` of `token0` goes to the seller (`_executeMatch`). `OrderMatched` is emitted per fill.
6. A resting order whose `amount` reaches zero is unlinked from its list.
7. Whatever is left of the taker's `amount` after matching is written as a new `Order`, assigned `++orderCount` as its id, inserted into its list by `_insertOrder`, and announced with `OrderPlaced`. A taker order that fills completely is never stored and never gets an id.

`_insertOrder` walks the list from the head and stops at the first order with a strictly worse price, so an order at an existing price level goes behind the orders already there. That gives price-time priority within a level.

### Cancelling an order

`cancelOrder(orderId)`:

1. Reverts with `NotOrderOwner` unless `msg.sender` is the stored owner.
2. Walks the order's side of the book from the head until it finds `orderId`. If it reaches the end first, the order was already filled or cancelled, and the call reverts with `OrderNotFoundOrCancelled`.
3. Unlinks the order, transfers the stored remaining `amount` of the locked token back to the owner, and emits `OrderCancelled`.

### Reading the book

- `getBestBid()` and `getBestAsk()` return the head price of each list, or `0` when that side is empty.
- `getOrderBookDepth()` walks both lists and returns `(bidDepth, askDepth)` as order counts.
- `getOrderBook()` returns two arrays of `OrderInfo { orderId, owner, price, amount, isBid }`, bids best-first and asks best-first. The frontend's order book component calls this on every poll.
- `orders(id)`, `orderCount`, `bidHead`, `askHead`, `token0`, `token1` are public getters.

## Public interface

### Functions

| Signature | Mutability | Description |
| --- | --- | --- |
| `constructor(address _token0, address _token1)` | | Sets the pair. No ordering check is performed on the addresses. |
| `placeOrder(uint256 price, uint256 amount, bool isBid)` | nonpayable | Lock tokens, match against the opposite side, rest any remainder. |
| `cancelOrder(uint128 orderId)` | nonpayable | Unlink the caller's resting order and refund its remaining amount. |
| `getBestBid() returns (uint256)` | view | Price at `bidHead`, or 0. |
| `getBestAsk() returns (uint256)` | view | Price at `askHead`, or 0. |
| `getOrderBookDepth() returns (uint128 bidDepth, uint128 askDepth)` | view | Number of live orders on each side. |
| `getOrderBook() returns (OrderInfo[] bids, OrderInfo[] asks)` | view | Full sorted snapshot of both sides. |
| `orders(uint128) returns (address owner, uint256 price, uint256 amount, uint128 next, bool isBid)` | view | Raw order record, including unlinked orders. |
| `orderCount() returns (uint128)` | view | Last assigned order id. |
| `bidHead() / askHead() returns (uint128)` | view | Head of each list. |
| `token0() / token1() returns (IERC20)` | view | The pair. |

### Events

| Event | When |
| --- | --- |
| `OrderPlaced(uint128 orderId, address owner, uint256 price, uint256 amount, bool isBid)` | An order (or the unfilled remainder of one) is added to the book. `amount` is the resting amount, not the original request. |
| `OrderMatched(uint128 orderId1, uint128 orderId2, uint256 price, uint256 amount)` | One fill executed. `price` is the resting order's price and `amount` is the `token1` quantity. Both id fields are currently emitted as `0`. |
| `OrderCancelled(uint128 orderId)` | An order was unlinked by its owner and refunded. |

### Errors

| Error | Selector | Raised by |
| --- | --- | --- |
| `InvalidPriceOrAmount()` | `0x88f12bba` | `placeOrder` with a zero price or amount |
| `TransferFailed()` | `0x90b8ec18` | `placeOrder` deposit or `cancelOrder` refund returned `false` |
| `NotOrderOwner()` | `0xf6412b5a` | `cancelOrder` by a non-owner |
| `OrderNotFoundOrCancelled()` | `0x01a5bd33` | `cancelOrder` on an order that is not in the book |
| `TransferToBuyerFailed()` | `0x35d2079c` | `token1` payout in `_executeMatch` returned `false` |
| `TransferToSellerFailed()` | `0xb24b704a` | `token0` payout in `_executeMatch` returned `false` |

## Limitations and known issues

These are properties of the code as it stands. Some are deliberate simplifications for a workshop; the first one is a bug.

- **Bid accounting mixes units.** A resting bid's `amount` is `token0`, but when an ask fills it, `_matchOrders` subtracts the `token1` fill size from it while paying out `fill * price / 1e18` of `token0`. At any price other than `1e18` the stored remainder no longer matches the `token0` actually held for that order. `testSellMatchBid` pins this behaviour: a 10 `token0` bid at price 2 is hit by a 3 `token1` ask, the seller receives 6 `token0`, and the bid's remaining `amount` reads 7 instead of 4. A later `cancelOrder` on that bid would try to refund 7 from the contract's pooled balance. Bid-then-ask matching (`testBuyMatchAsk`) is consistent because that path converts units correctly.
- **`OrderMatched` does not identify the orders.** Both id arguments are hardcoded to `0`. Indexers have to reconstruct fills from balance changes or `OrderPlaced` deltas.
- **Every list walk is linear in book depth.** Insertion, cancellation, and matching all traverse from the head, so gas grows with the number of resting orders and a deep enough book makes some operations unaffordable. `getOrderBook` is a `view`, but a large book can still exceed an RPC node's call gas limit.
- **Integer rounding.** `remaining * 1e18 / price` and `fill * price / 1e18` both round down. A bid can be left with a few wei of `token0` that rest as a dust order.
- **No self-trade check, no fees, no expiry, no order types.** Every order is a plain limit order that matches what it can and rests the remainder. You can fill your own resting order.
- **Assumes well-behaved ERC20s.** The minimal `IERC20` interface expects `transfer` and `transferFrom` to return `bool`; tokens that return nothing will revert on decode. There is no reentrancy guard, so tokens with transfer hooks should not be used.
- **Filled orders are not cleared.** `orders(id)` keeps returning the last state of an unlinked order, and `owner` stays set, so `cancelOrder` on a filled order fails with `OrderNotFoundOrCancelled` rather than `NotOrderOwner`.
- **Mock tokens are unrestricted.** Both `BTC` and `USDC` expose a public `mint(address, uint256)` with no access control. The `USDC` source comment says 6 decimals, but `decimals()` is not overridden, so it is 18 like `BTC`.
- **Deploy script mints to a hardcoded address.** `DeployYourContract.s.sol` mints 100 BTC and 100 USDC to `0xB8232dcD45A5a2f1D2f1D73e04D00740c1911Ee2`. Change that to your own address before deploying.

## Running it

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (`forge`, `anvil`, `cast`)
- Node.js >= 20.18.3 and Yarn (the repo pins Yarn 3.2.3 via `packageManager`)
- Git

### Install

```bash
git clone --recurse-submodules https://github.com/monad-developers/workshop-clob.git
cd workshop-clob
yarn install
```

If you cloned without `--recurse-submodules`, fetch the Foundry libraries with:

```bash
git submodule update --init --recursive
```

### Build and test

```bash
cd packages/foundry
forge build
forge test -vv
```

`yarn foundry:test` from the repo root runs the same thing. The suite in `test/CLOB.t.sol` covers resting a bid, resting an ask, a bid crossing an ask, an ask crossing a bid, and cancel-with-refund. `-vv` shows the `console.log` balance output the tests print.

### Run locally

Three terminals from the repo root:

```bash
yarn chain     # anvil on http://127.0.0.1:8545 (chain id 31337)
yarn deploy    # runs script/Deploy.s.sol against anvil, regenerates packages/nextjs/contracts/deployedContracts.ts
yarn start     # Next.js on http://localhost:3000
```

The trade UI is at `/trade`, and `/debug` exposes every contract function through the Scaffold-ETH debugger. Note that `scaffold.config.ts` targets Monad testnet by default; set `targetNetworks` to `[chains.foundry]` to point the frontend at anvil.

### Monad network details

| Network | Chain ID | RPC | In `foundry.toml` as |
| --- | --- | --- | --- |
| Monad mainnet | 143 | `https://rpc.monad.xyz` | not yet configured |
| Monad testnet | 10143 | `https://testnet-rpc.monad.xyz` | `monadTestnet` |

The frontend (`scaffold.config.ts`) and the committed `deployments/10143.json` both point at testnet.

### Deploy to Monad

1. Create or import a deployer keystore. Scaffold-ETH wraps `cast wallet`:

   ```bash
   yarn account:generate     # new key, prints the address to fund
   # or
   yarn account:import       # import an existing private key
   ```

   Then pass `--keystore <name>` to `yarn deploy` and fund that account with MON. `yarn deploy` refuses to use the default anvil key on a live network.

2. For mainnet, add the endpoint to `[rpc_endpoints]` in `packages/foundry/foundry.toml`:

   ```toml
   monad = "https://rpc.monad.xyz"
   ```

   Testnet is already there as `monadTestnet`.

3. Edit the mint recipient in `script/DeployYourContract.s.sol` to your own address, then deploy:

   ```bash
   yarn deploy --network monad --keystore <name>          # mainnet, after step 2
   yarn deploy --network monadTestnet --keystore <name>   # testnet
   ```

   This runs `forge script script/Deploy.s.sol --rpc-url <network> --broadcast --legacy --ffi` with the keystore you named and regenerates the frontend ABIs. If you omit `--keystore` on a live network, the wrapper opens an interactive keystore picker, so always pass it in scripts and CI. Deploy order is `BTC`, `USDC`, then `CLOB(btc, usdc)`.

   Without the Yarn wrapper, the equivalent is:

   ```bash
   cd packages/foundry
   forge script script/Deploy.s.sol \
     --rpc-url https://rpc.monad.xyz \
     --account <keystore-name> \
     --broadcast --legacy --ffi
   ```

4. Update `targetNetworks` in `packages/nextjs/scaffold.config.ts` to match the network you deployed to, then `yarn start`.

### Talking to the contract with `cast`

Approve the CLOB to pull the token your order locks, then place the order. Prices and amounts are 18-decimal integers.

```bash
export RPC=https://rpc.monad.xyz
export CLOB=<clob address>
export TOKEN0=<btc address>
export TOKEN1=<usdc address>

# rest a bid: lock 10 token0 at price 2 token0 per token1
cast send $TOKEN0 "approve(address,uint256)" $CLOB 10ether --rpc-url $RPC --account <keystore-name>
cast send $CLOB "placeOrder(uint256,uint256,bool)" 2ether 10ether true --rpc-url $RPC --account <keystore-name>

# rest an ask: lock 5 token1 at price 3
cast send $TOKEN1 "approve(address,uint256)" $CLOB 5ether --rpc-url $RPC --account <keystore-name>
cast send $CLOB "placeOrder(uint256,uint256,bool)" 3ether 5ether false --rpc-url $RPC --account <keystore-name>

# read the book
cast call $CLOB "getBestBid()(uint256)" --rpc-url $RPC
cast call $CLOB "getBestAsk()(uint256)" --rpc-url $RPC
cast call $CLOB "getOrderBookDepth()(uint128,uint128)" --rpc-url $RPC
cast call $CLOB "getOrderBook()((uint128,address,uint256,uint256,bool)[],(uint128,address,uint256,uint256,bool)[])" --rpc-url $RPC

# cancel order 1
cast send $CLOB "cancelOrder(uint128)" 1 --rpc-url $RPC --account <keystore-name>
```

`cast` accepts `ether` as shorthand for `* 1e18`, which is why it works for 18-decimal prices and amounts here.

## Where to go from here

If you use this as a starting point, the obvious first changes are to fix the bid accounting so a resting bid tracks its `token0` in one unit, populate the ids in `OrderMatched`, and replace the linear list walks with a price-level structure that bounds gas per operation. All of those are good workshop exercises, and the existing tests will tell you when you have broken the behaviour they pin.

## License

See [LICENCE](LICENCE).
