class MYDisableGroup:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "group_data": ("STRING", {"default": "[]", "multiline": True}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "run"
    OUTPUT_NODE = True
    CATEGORY = "MY节点/控制"

    def run(self, group_data):
        return {}


NODE_CLASS_MAPPINGS = {
    "MYDisableGroup": MYDisableGroup,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "MYDisableGroup": "MY禁用组",
}
