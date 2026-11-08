---------------------------- MODULE Lifecycle ----------------------------
(***************************************************************************)
(* One post: calibration state (scoring.md A.7) x base status (moderation. *)
(* md A.2) x restrictions, the `limited -> public` promotion (mo#A.2, B.2) *)
(* and the derived `post_status` / `post_eligibility` views (dm#A.4).      *)
(*                                                                         *)
(* Numbers are abstracted: `enough` stands for n >= 20, the distribution   *)
(* checks of A.7 are a non-deterministic pass/fail, trust_score is a       *)
(* boolean (>= TRUST_PUBLIC_THRESHOLD or not).                             *)
(***************************************************************************)
EXTENDS Naturals

CONSTANT RestorePromotes
  \* BOOLEAN. TRUE = moderation.md A.7 (#70, #71): `restore` of a `limited` +
  \* `calibrated` post without upheld reports promotes it to `public`.
  \* FALSE = the wording before #71, under which L4 fails (see README).
ASSUME RestorePromotes \in BOOLEAN

VARIABLES
  base,        \* draft limited public unpublished removed
  calib,       \* uncalibrated calibrated review invalid
  indiv,       \* indiv_restricted
  treeLocked,  \* an ancestor-or-self is in tree_locks
  upheld,      \* the post has an upheld report
  openRep,     \* the post has open reports
  thumb,       \* thumb_key is set (job after publish, mc#A.9)
  enough,      \* n >= 20 plays in the distribution
  trustHigh,   \* author's trust_score >= TRUST_PUBLIC_THRESHOLD
  gone,        \* draft deleted (row removed)
  lastOp       \* name of the last operation (for action properties)

vars == << base, calib, indiv, treeLocked, upheld, openRep, thumb, enough, trustHigh, gone, lastOp >>

Init ==
  /\ base = "draft" /\ calib = "uncalibrated"
  /\ indiv = FALSE /\ treeLocked = FALSE /\ upheld = FALSE /\ openRep = FALSE
  /\ thumb = FALSE /\ enough = FALSE /\ trustHigh \in BOOLEAN /\ gone = FALSE
  /\ lastOp = "init"

(* Derived views, dm#A.4 *)
Status ==
  IF gone THEN "gone"
  ELSE IF base \in {"removed", "unpublished", "draft"} THEN base
  ELSE IF indiv \/ treeLocked THEN "restricted"
  ELSE base

Eligibility ==
  IF Status = "public" /\ calib = "calibrated" THEN "normal"
  ELSE IF Status \in {"limited", "public"} /\ calib = "uncalibrated" /\ thumb THEN "new"
  ELSE "none"

Visible == Status \in {"limited", "public"}

Alive == ~gone

(* Promotion condition, mo#A.2: not indiv_restricted and no upheld report *)
CanPromote == ~indiv /\ ~upheld

(***************************************************************************)
(* Author / site                                                           *)
(***************************************************************************)
Publish ==
  /\ Alive /\ base = "draft"
  /\ base' = IF trustHigh THEN "public" ELSE "limited"
  /\ lastOp' = "publish"
  /\ UNCHANGED << calib, indiv, treeLocked, upheld, openRep, thumb, enough, trustHigh, gone >>

DeleteDraft ==
  /\ Alive /\ base = "draft"
  /\ gone' = TRUE /\ lastOp' = "delete_draft"
  /\ UNCHANGED << base, calib, indiv, treeLocked, upheld, openRep, thumb, enough, trustHigh >>

Thumbnail ==
  /\ Alive /\ base \in {"limited", "public"} /\ ~thumb
  /\ thumb' = TRUE /\ lastOp' = "thumb_job"
  /\ UNCHANGED << base, calib, indiv, treeLocked, upheld, openRep, enough, trustHigh, gone >>

Unpublish ==
  /\ Alive /\ base \in {"limited", "public"}
  /\ base' = "unpublished" /\ lastOp' = "unpublish"
  /\ UNCHANGED << calib, indiv, treeLocked, upheld, openRep, thumb, enough, trustHigh, gone >>

Republish ==
  /\ Alive /\ base = "unpublished"
  /\ base' = IF calib = "calibrated" /\ CanPromote THEN "public"
             ELSE IF trustHigh THEN "public" ELSE "limited"
  /\ lastOp' = "republish"
  /\ UNCHANGED << calib, indiv, treeLocked, upheld, openRep, thumb, enough, trustHigh, gone >>

(* Players: a result enters the distribution only from the new-game slot,
   i.e. when the post is eligible as "new" (sc#A.4, dm#A.4). *)
Play ==
  /\ Alive /\ Eligibility = "new" /\ ~enough
  /\ enough' = TRUE /\ lastOp' = "play"
  /\ UNCHANGED << base, calib, indiv, treeLocked, upheld, openRep, thumb, trustHigh, gone >>

(***************************************************************************)
(* Calibration (sc#A.7). The check runs once n >= 20; the limited->public  *)
(* promotion is in the same transaction (mo#A.2).                          *)
(***************************************************************************)
Calibrate ==
  /\ Alive /\ calib = "uncalibrated" /\ enough
  /\ \E pass \in BOOLEAN :
       /\ calib' = IF pass THEN "calibrated" ELSE "invalid"
       /\ base' = IF pass /\ base = "limited" /\ CanPromote THEN "public" ELSE base
  /\ lastOp' = "calibrate"
  /\ UNCHANGED << indiv, treeLocked, upheld, openRep, thumb, enough, trustHigh, gone >>

ToReview ==
  /\ Alive /\ calib = "calibrated"
  /\ calib' = "review" /\ lastOp' = "to_review"
  /\ UNCHANGED << base, indiv, treeLocked, upheld, openRep, thumb, enough, trustHigh, gone >>

\* mo#A.2: "the transition in which `calibration` becomes `calibrated`"
\* promotes, so `calibration_confirm` (review -> calibrated) promotes too.
CalibrationConfirm ==
  /\ Alive /\ calib = "review"
  /\ calib' = "calibrated" /\ lastOp' = "calibration_confirm"
  /\ base' = IF base = "limited" /\ CanPromote THEN "public" ELSE base
  /\ UNCHANGED << indiv, treeLocked, upheld, openRep, thumb, enough, trustHigh, gone >>

CalibrationInvalidate ==
  /\ Alive /\ calib = "review"
  /\ calib' = "invalid" /\ lastOp' = "calibration_invalidate"
  /\ UNCHANGED << base, indiv, treeLocked, upheld, openRep, thumb, enough, trustHigh, gone >>

(***************************************************************************)
(* Reports and moderation (mo#A.4, A.7), as far as they touch this post.   *)
(***************************************************************************)
Report ==
  /\ Alive /\ Status \in {"limited", "public", "restricted"}
  /\ openRep' = TRUE
  /\ \E auto \in BOOLEAN : indiv' = (indiv \/ auto)   \* auto restrict (weights abstracted)
  /\ lastOp' = "report"
  /\ UNCHANGED << base, calib, treeLocked, upheld, thumb, enough, trustHigh, gone >>

Restrict ==
  /\ Alive /\ base \notin {"draft", "removed"}
  /\ indiv' = TRUE /\ upheld' = (upheld \/ openRep) /\ openRep' = FALSE
  /\ lastOp' = "restrict"
  /\ UNCHANGED << base, calib, treeLocked, thumb, enough, trustHigh, gone >>

Restore ==
  /\ Alive /\ base \in {"limited", "public", "unpublished"}
  /\ indiv' = FALSE /\ openRep' = FALSE
  /\ base' = IF RestorePromotes /\ base = "limited" /\ calib = "calibrated" /\ ~upheld
             THEN "public" ELSE base
  /\ lastOp' = "restore"
  /\ UNCHANGED << calib, treeLocked, upheld, thumb, enough, trustHigh, gone >>

Remove ==
  /\ Alive /\ base \in {"limited", "public", "unpublished"}
  /\ base' = "removed" /\ upheld' = (upheld \/ openRep) /\ openRep' = FALSE
  /\ lastOp' = "remove"
  /\ UNCHANGED << calib, indiv, treeLocked, thumb, enough, trustHigh, gone >>

RestrictTree ==
  /\ Alive /\ ~treeLocked
  /\ treeLocked' = TRUE /\ upheld' = (upheld \/ openRep) /\ openRep' = FALSE
  /\ lastOp' = "restrict_tree"
  /\ UNCHANGED << base, calib, indiv, thumb, enough, trustHigh, gone >>

\* mo#A.7: restore_tree also promotes qualifying descendants (this post is
\* one of them) that are not individually restricted.
RestoreTree ==
  /\ Alive /\ treeLocked
  /\ treeLocked' = FALSE /\ lastOp' = "restore_tree"
  /\ base' = IF RestorePromotes /\ base = "limited" /\ calib = "calibrated" /\ ~upheld /\ ~indiv
             THEN "public" ELSE base
  /\ UNCHANGED << calib, indiv, upheld, openRep, thumb, enough, trustHigh, gone >>

Next ==
  \/ Publish \/ DeleteDraft \/ Thumbnail \/ Unpublish \/ Republish \/ Play
  \/ Calibrate \/ ToReview \/ CalibrationConfirm \/ CalibrationInvalidate
  \/ Report \/ Restrict \/ Restore \/ Remove \/ RestrictTree \/ RestoreTree

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Properties                                                              *)
(***************************************************************************)
TypeOK ==
  /\ base \in {"draft", "limited", "public", "unpublished", "removed"}
  /\ calib \in {"uncalibrated", "calibrated", "review", "invalid"}

\* L1: `invalid` is terminal (sc#A.7)
L1 == [][calib = "invalid" => calib' = "invalid"]_vars

\* L2: `calibrated` is entered from `uncalibrated` only with n >= 20
L2 == [][calib = "uncalibrated" /\ calib' = "calibrated" => enough]_vars

\* L3: the normal slot needs public + calibrated; the new slot needs
\* limited/public + uncalibrated + a thumbnail (dm#A.4, sc#A.8, mo#A.8)
L3 == /\ Eligibility = "normal" => Status = "public" /\ calib = "calibrated"
      /\ Eligibility = "new" => Status \in {"limited", "public"} /\ calib = "uncalibrated" /\ thumb
      /\ Status \notin {"limited", "public"} => Eligibility = "none"

\* L4: a visible `limited` post that is `calibrated` has (or had) a reason
\* not to be promoted: an upheld report. The A.8 table says this case does
\* not occur "unless the post is restricted or has an upheld report".
L4 == (Status = "limited" /\ calib = "calibrated") => upheld

\* L5: a promotion never turns a restricted post visible (mo#M8): if the
\* post was restricted before the step it is still not visible after it,
\* unless the step is the restore itself.
L5 == [][base = "limited" /\ base' = "public" /\ Status = "restricted"
          => Status' = "restricted" \/ lastOp' \in {"restore", "restore_tree"}]_vars

\* L6: results enter the distribution only through the new slot
L6 == [][~enough /\ enough' => Eligibility = "new"]_vars

Invariants == TypeOK /\ L3 /\ L4

=============================================================================
