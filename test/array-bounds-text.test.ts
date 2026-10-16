import { expect, test } from 'vitest';
import { rewriteArrayBoundsText } from '../src/sql/array-bounds-text.ts';

test('rewrites first-dimension bounds and keeps every other character', () => {
  expect(
    rewriteArrayBoundsText(
      'delete from "t" returning array_upper("tags", 1), ARRAY_LOWER ( tags , 1 )'
    )
  ).toBe(
    'delete from "t" returning nullif(array_length("tags"), 0), CASE WHEN array_length(tags) > 0 THEN 1 ELSE NULL END'
  );
  expect(rewriteArrayBoundsText('select array_upper($1, 1), $2')).toBe(
    'select nullif(array_length($1), 0), $2'
  );
});

test('binds a possibly volatile array once and handles nesting', () => {
  expect(
    rewriteArrayBoundsText(
      'select array_upper(list_value(array_upper(x, 1), random()), 1)'
    )
  ).toBe(
    'select list_extract(list_transform(list_value(array_length(list_value(nullif(array_length(x), 0), random()))), __drizzle_array_length -> nullif(__drizzle_array_length, 0)), 1)'
  );
});

test('leaves strings, identifiers, comments and other calls alone', () => {
  for (const query of [
    "select 'array_upper(x, 1)'",
    'select "array_upper(x, 1)" from t',
    'select 1 -- array_upper(x, 1)',
    'select /* array_upper(x, 1) */ 1',
    'select $$array_upper(x, 1)$$, $tag$array_upper(x, 1)$tag$',
    'select main.array_upper(x, 1)',
    'select my_array_upper(x, 1)',
    'select array_upper(x, 2), array_upper(x), array_upper(x, 1, 2)',
    'select array_upper(x, 1',
  ]) {
    expect(rewriteArrayBoundsText(query)).toBe(query);
  }
  expect(
    rewriteArrayBoundsText("select array_upper(['a,b', 'c)'], 1) -- note")
  ).toBe("select nullif(array_length(['a,b', 'c)']), 0) -- note");
});
