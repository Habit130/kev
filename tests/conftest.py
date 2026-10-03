"""Shared test configuration.

`integration` marks cases that need real local model artifacts and an explicit opt-in
(`KEV_LOCAL_INFERENCE_CONFIG`); they are selected with `-k integration` and excluded from the default fast selection.
Registering the marker here keeps production packaging files unchanged.
"""


def pytest_configure(config):
    config.addinivalue_line("markers", "integration: needs real local model artifacts (KEV_LOCAL_INFERENCE_CONFIG)")
