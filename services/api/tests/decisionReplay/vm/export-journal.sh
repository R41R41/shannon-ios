for w in "2026-10-22 12:23:00|2026-10-22 12:48:30" "2026-10-22 14:46:00|2026-10-22 15:17:00" "2026-10-22 17:19:30|2026-10-22 17:31:00"; do
  s="${w%%|*}"; u="${w##*|}"
  journalctl -u shannon-ios --since "$s" --until "$u" --no-pager -o short-iso 2>&1 | grep -E '"event":"fca_decision_metrics"|"event":"fca_request_size"|"event":"fca_input_transformations"|FCA history summary|lookahead' | sed -e 's/^\([^ ]*\) [^ ]* node\[[0-9]*\]: /\1 /'
done
