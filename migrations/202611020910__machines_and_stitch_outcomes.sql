-- "My Machine" profiles and stitch-outcome capture.
-- Feeds the fit check, the North Star metric ("designs stitched successfully per week")
-- and the stitch-quality dataset. Collect from the first sale; data not captured early is lost.

CREATE TABLE design_user_machines (
  id                 CHAR(36)     PRIMARY KEY,
  user_id            CHAR(36)     NOT NULL,
  nickname           VARCHAR(80)  NULL COMMENT 'e.g. "Studio machine"',
  machine_brand      VARCHAR(80)  NOT NULL,
  machine_model      VARCHAR(120) NOT NULL,
  preferred_format   VARCHAR(20)  NOT NULL COMMENT 'Validated against the app format registry',
  hoops_json         JSON         NOT NULL COMMENT '[{"name":"5x7","widthMm":130,"heightMm":180}]',
  machine_profile_id CHAR(36)     NULL COMMENT 'Closest validated system profile, if any',
  is_default         BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_user_machines_user (user_id),
  KEY idx_user_machines_model (machine_brand, machine_model),
  CONSTRAINT fk_user_machines_user    FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_user_machines_profile FOREIGN KEY (machine_profile_id) REFERENCES design_machine_profiles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE design_stitch_outcomes (
  id                   CHAR(36)     PRIMARY KEY,
  artifact_id          CHAR(36)     NOT NULL COMMENT 'The machine file that was stitched',
  project_id           CHAR(36)     NOT NULL COMMENT 'Denormalised for per-design aggregation',
  user_id              CHAR(36)     NOT NULL,
  user_machine_id      CHAR(36)     NULL,
  source               ENUM('customer','designer','staff_stitch_out','support_ticket') NOT NULL,
  outcome              ENUM('success','minor_issues','failed','did_not_stitch') NOT NULL,
  rating               TINYINT UNSIGNED NULL,
  issue_codes          JSON         NULL COMMENT 'Subset of: wont_open, too_big_for_hoop, puckering, gaps, thread_breaks, registration, density_too_high, too_many_trims, other',
  machine_brand        VARCHAR(80)  NULL COMMENT 'Copied at report time so later machine edits do not rewrite history',
  machine_model        VARCHAR(120) NULL,
  hoop_width_mm        DECIMAL(7,2) NULL,
  hoop_height_mm       DECIMAL(7,2) NULL,
  fabric_type          ENUM('woven_cotton','knit','towel','denim','canvas','cap','felt','leather','other') NULL,
  stabilizer_type      ENUM('cutaway','tearaway','washaway','heat_away','none','other') NULL,
  thread_brand         VARCHAR(80)  NULL,
  thread_weight        VARCHAR(20)  NULL,
  needle               VARCHAR(40)  NULL,
  comment              VARCHAR(2000) NULL,
  photo_storage_keys   JSON         NULL COMMENT 'Private S3 keys; never user-supplied paths',
  photo_consent        ENUM('private','support_only','public_review') NOT NULL DEFAULT 'private',
  review_status        ENUM('not_a_review','pending','published','hidden') NOT NULL DEFAULT 'not_a_review',
  anonymised_at        DATETIME(3)  NULL COMMENT 'Set when the user is deleted; outcome data is kept without personal data',
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  KEY idx_outcomes_project (project_id, created_at),
  KEY idx_outcomes_artifact (artifact_id),
  KEY idx_outcomes_machine (machine_brand, machine_model),
  KEY idx_outcomes_weekly (outcome, created_at),
  KEY idx_outcomes_reviews (review_status, project_id),
  CONSTRAINT fk_outcomes_artifact FOREIGN KEY (artifact_id) REFERENCES design_artifacts(id),
  CONSTRAINT fk_outcomes_project  FOREIGN KEY (project_id) REFERENCES design_projects(id),
  CONSTRAINT fk_outcomes_user     FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_outcomes_machine  FOREIGN KEY (user_machine_id) REFERENCES design_user_machines(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
