# GW2 Trading Post Checker

## Current Orders

Use **Current Orders** in the launcher to inspect the authenticated Guild Wars 2 account's active Trading Post transactions.

- Choose **Buy orders** or **Sell orders** with the selector at the top of the window.
- Listings for the same item are combined per order type, with quantities summed and the price shown as a quantity-weighted unit price.
- Rows are sorted by the most recent listing date, newest first. The date shown for a combined row is its most recent listing date.
- Select **Refresh** to fetch the latest transactions from the API.
- Item names are resolved from the public GW2 item endpoint and cached for the app session.

The feature uses these authenticated endpoints:

- `/v2/commerce/transactions/current/buys`
- `/v2/commerce/transactions/current/sells`


## Transaction History

Use **Transaction History** in the launcher to inspect completed Trading Post transactions.

- Choose **Buy history** or **Sell history**; only the selected type is shown.
- The top total is the combined value of every transaction currently shown.
- Each item row combines all transactions for that item and shows the total quantity and total transaction value.
- Click an item row to expand its daily chart. The chart shows every day in the history range, including zero-activity days, with the total quantity bought or sold and total gold for that day available on hover.
- Select **Refresh** to fetch the latest history from the API.

The feature uses these authenticated endpoints:

- `/v2/commerce/transactions/history/buys`
- `/v2/commerce/transactions/history/sells`