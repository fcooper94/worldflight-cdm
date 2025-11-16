CREATE TABLE airports (icao varchar(4) primary key, name text, timezone
text, arrivals_per_hour int);
INSERT INTO airports (icao,name,timezone,arrivals_per_hour) VALUES
('FAOR','O.R. Tambo Intl','Africa/Johannesburg',20);