"""Nightly data pipeline for studenttrustee.net.

Modules:
  boundaries  district polygons snapshot (ArcGIS -> studenttrustee/data/districts.geojson)
  common      HTTP with caching and retries, manifest bookkeeping
  federal     Congress.gov, House Clerk, Senate LIS, docs.house.gov
  california  LegInfo pubinfo dump
  counties    Legistar Web API + link-only counties
  geo         counties, districts per county
  writer      atomic, deterministic JSON output
  validate    schema and integrity checks
  refresh     CLI entry point (python3 -m tools.legislation.refresh --all)
"""
