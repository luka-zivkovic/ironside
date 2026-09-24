-- Project-defined model prices. Checked before the vendored price table when
-- the worker derives cost for an observation that reported usage but no
-- cost (spec/cost-pricing-v1.md). Ordered by position; first match wins.
create table project_model_prices (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  position integer not null,
  pattern text not null,
  input_cost_per_token numeric(24, 15),
  output_cost_per_token numeric(24, 15),
  cache_read_input_token_cost numeric(24, 15),
  cache_write_input_token_cost numeric(24, 15),
  created_at timestamptz not null default now(),
  unique (project_id, position),
  constraint project_model_prices_pattern_length check (char_length(pattern) between 1 and 200),
  constraint project_model_prices_nonnegative check (
    coalesce(input_cost_per_token, 0) >= 0
    and coalesce(output_cost_per_token, 0) >= 0
    and coalesce(cache_read_input_token_cost, 0) >= 0
    and coalesce(cache_write_input_token_cost, 0) >= 0
  ),
  constraint project_model_prices_has_price check (
    input_cost_per_token is not null
    or output_cost_per_token is not null
    or cache_read_input_token_cost is not null
    or cache_write_input_token_cost is not null
  )
);
