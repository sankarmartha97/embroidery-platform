-- Reference data: system machine profiles and a generic sample thread palette.
-- PLACEHOLDER VALUES: hoop sizes and limits must be verified by the embroidery
-- specialist against the physical test matrix before production (see seed-data.md).

INSERT INTO design_machine_profiles
  (id, owner_user_id, name, format_code, hoop_width_mm, hoop_height_mm,
   min_stitch_length_mm, max_stitch_length_mm, max_jump_length_mm, trim_jump_threshold_mm, max_colors)
VALUES
  ('00000000-0000-7000-8000-000000000101', NULL, 'Tajima-compatible 100 x 100', 'DST', 100.00, 100.00, 0.30, 12.10, NULL, 7.00, NULL),
  ('00000000-0000-7000-8000-000000000102', NULL, 'Brother 4x4',                 'PES', 100.00, 100.00, 0.30, 12.10, NULL, 7.00, NULL),
  ('00000000-0000-7000-8000-000000000103', NULL, 'Brother 5x7',                 'PES', 130.00, 180.00, 0.30, 12.10, NULL, 7.00, NULL),
  ('00000000-0000-7000-8000-000000000104', NULL, 'Janome SQ14',                 'JEF', 140.00, 140.00, 0.30, 12.70, NULL, 7.00, NULL),
  ('00000000-0000-7000-8000-000000000105', NULL, 'Janome RE20',                 'JEF', 170.00, 200.00, 0.30, 12.70, NULL, 7.00, NULL);

INSERT INTO design_thread_palette_items (id, brand, color_code, color_name, hex_rgb)
VALUES
  ('00000000-0000-7000-8000-000000000201', 'Generic', 'G001', 'Black',      '#000000'),
  ('00000000-0000-7000-8000-000000000202', 'Generic', 'G002', 'White',      '#FFFFFF'),
  ('00000000-0000-7000-8000-000000000203', 'Generic', 'G003', 'Red',        '#CC3344'),
  ('00000000-0000-7000-8000-000000000204', 'Generic', 'G004', 'Royal Blue', '#2255AA'),
  ('00000000-0000-7000-8000-000000000205', 'Generic', 'G005', 'Kelly Green','#2E8B3E'),
  ('00000000-0000-7000-8000-000000000206', 'Generic', 'G006', 'Gold',       '#D4A017'),
  ('00000000-0000-7000-8000-000000000207', 'Generic', 'G007', 'Grey',       '#808080'),
  ('00000000-0000-7000-8000-000000000208', 'Generic', 'G008', 'Pink',       '#E58FB0');
