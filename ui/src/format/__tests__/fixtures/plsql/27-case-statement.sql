begin case v_status when 'N' then v_text := 'new'; when 'P' then v_text := 'paid'; v_flag := true; else v_text := 'other'; end case; case when v_total > 100 then big(); else small(); end case; end;
/
