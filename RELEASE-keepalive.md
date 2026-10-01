# dsh-model-fusion 0.2.6

Supports DeepSeek Harness **0.2.0-rc.2**.

Cheaper cache keepalive, measured on the ChatGPT subscription route (gpt-6-astra, about 20k tokens of context):

- Each ping now resends the Lead's previous request with "Reply OK" appended instead of "continue". The model answers with 5 output tokens, no reasoning and no tool call (16 of 16 trials). With "continue" it called tools every time; the median ping produced 463 output tokens.
- The cache was still there after 10 idle minutes and gone after 15, and every ping restarts that clock. The ChatGPT subscription route therefore defaults to one ping every 8 minutes (was 285 seconds).
- The interval is shortened only when 3 of the last 5 pings at that interval missed. Before, two scattered random evictions were enough to shorten it. Intervals learned under the old rule are ignored.
- The settings page shows the output tokens spent on pings.

Replayed over the real waits in the session logs, pings dropped from 126 to 57 and keepalive cost fell by about 78%.

Install in Desktop Settings → Plugins → Add plugin:

```text
dsh-model-fusion@0.2.6
```

Validation was on macOS arm64 with DSH 0.2.0-rc.2. No new Windows or Linux runtime acceptance is claimed.
