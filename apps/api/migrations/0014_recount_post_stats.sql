-- post_stats を sessions から数え直す（sc#A.4、I15。#246）。
-- 作者がランで遊んだ結果を分布に入れるようにした（#242）。それより前の作者の結果は sessions にあるが
-- post_stats に入っていない。そのままだと、1 主体 5 件の窓がそれを「入っている結果」として押し出し、
-- 足していない点数や失敗を引いてしまう。今の規則（apps/api/src/turns.ts の窓と同じ条件）で数え直して揃える。
-- 校正状態はここでは変えない（次の結果の受理で決まる）。
with eligible as (
  select post_id, via, score,
    row_number() over (
      partition by post_id, actor_id order by submitted_at desc, id desc
    ) as rn
  from sessions
  where state = 'submitted' and speed = 1
    and (via in ('timeout', 'error')
      or (via = 'guest' and verdict in ('provisional', 'accepted')
        and frames >= 0.9 * time_limit))
), counted as (
  select post_id,
    coalesce(array_agg(score order by score) filter (where via = 'guest'), '{}')::int[] as scores,
    (count(*) filter (where via <> 'guest'))::int as failures
  from eligible
  where rn <= 5
  group by post_id
)
insert into post_stats (post_id, n, scores, failures, updated_at)
select post_id, cardinality(scores), scores, failures, now() from counted
on conflict (post_id) do update
  set n = excluded.n, scores = excluded.scores, failures = excluded.failures,
      updated_at = excluded.updated_at;
